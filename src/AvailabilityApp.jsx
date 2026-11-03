/**
 * AvailabilityApp.jsx — production single-file component
 *
 * Group availability scheduler (When2Meet pattern) on Supabase + Luxon.
 *
 * Requires:
 *   - src/supabaseClient.js            (exports `supabase`)
 *   - supabase/schema.sql applied      (tables, RLS, triggers, RPC, realtime, cron)
 *   - Anonymous sign-ins enabled in Supabase Auth
 *   - npm i @supabase/supabase-js luxon lucide-react  + Tailwind v3
 *
 * Features: event codes, range OR specific dates, end date, slot sizes
 * 15 min → whole day + validated custom (snaps to 5), canonical event time
 * zone with DST-safe viewer relabeling, edit/withdraw own response,
 * duplicate-name disambiguation, response deadline (server-enforced),
 * organizer finalize (multiple slots), organizer edit-after-create,
 * anonymity (names stripped server-side for non-organizers), column-
 * selectable CSV export (always anonymized for non-organizers), 15-day
 * retention, realtime (polling fallback for anonymous non-organizers),
 * and a Section 508 / WCAG 2.1 AA accessibility pass.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import {
  ArrowLeft, Calendar, Check, ChevronLeft, ChevronRight, ClipboardCopy, Clock, Copy,
  Crown, Download, EyeOff, Globe, Info, Loader2, Lock, Pencil, RefreshCw, Star, Trash2,
  Users, X,
} from "lucide-react";
import { supabase } from "./supabaseClient";

/* =====================================================================
 * Constants
 * ===================================================================== */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const MAX_RANGE_DAYS = 62;
const MAX_CUSTOM_DATES = 31;
const RETENTION_DAYS = 15;
const POLL_MS = 8000;
const PRESET_GRANS = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 240, label: "4 hours" },
  { value: 480, label: "8 hours" },
  { value: 720, label: "12 hours" },
  { value: 1440, label: "Whole day" },
];
const FALLBACK_TZS = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico",
  "Pacific/Guam", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo",
  "Australia/Sydney",
];
const TZ_LIST = (() => {
  try {
    const list = Intl.supportedValuesOf("timeZone");
    return list.includes("UTC") ? list : ["UTC", ...list];
  } catch {
    return FALLBACK_TZS;
  }
})();

const FOCUS =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-700 focus-visible:ring-offset-2";
const BTN =
  `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const BTN_PRIMARY = `${BTN} bg-indigo-700 text-white hover:bg-indigo-800`;
const BTN_SECONDARY = `${BTN} border border-gray-400 bg-white text-gray-900 hover:bg-gray-100`;
const BTN_DANGER = `${BTN} border border-red-700 bg-white text-red-800 hover:bg-red-50`;
const INPUT =
  "w-full rounded-lg border border-gray-500 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-700 disabled:bg-gray-100 disabled:text-gray-600";
const LABEL = "mb-1 block text-sm font-medium text-gray-900";

/* =====================================================================
 * Date / time helpers (Luxon — DST-correct)
 * ===================================================================== */
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const todayISO = () => DateTime.local().toISODate();
const addDaysISO = (iso, n) => DateTime.fromISO(iso).plus({ days: n }).toISODate();
const daysBetween = (a, b) =>
  Math.round(DateTime.fromISO(b).diff(DateTime.fromISO(a), "days").days);
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const slotKey = (date, minutes) => `${date}|${hhmm(minutes)}`;

function buildDates(start, end) {
  const out = [];
  let d = DateTime.fromISO(start);
  const e = DateTime.fromISO(end);
  while (d <= e && out.length < 400) {
    out.push(d.toISODate());
    d = d.plus({ days: 1 });
  }
  return out;
}

/** Resolve an event row into its list of column dates (range or custom). */
function datesFromRow(row) {
  if (row.date_mode === "custom" && Array.isArray(row.dates) && row.dates.length) {
    return [...row.dates].sort();
  }
  return buildDates(row.start_date, row.end_date);
}

/** Slots for one day. Final slot is clipped to the window. Guarded against gran <= 0. */
function buildSlots(startHour, endHour, gran) {
  const out = [];
  if (!gran || gran < 1) return out;
  const s = startHour * 60;
  const e = endHour * 60;
  for (let m = s; m < e; m += gran) out.push({ start: m, end: Math.min(m + gran, e) });
  return out;
}

function fmtMinutes(m) {
  const h24 = Math.floor(m / 60) % 24;
  const mm = m % 60;
  const ampm = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${pad(mm)} ${ampm}`;
}

function fmtHour(h) {
  if (h === 0) return "12 AM (start of day)";
  if (h === 24) return "12 AM (end of day)";
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${ampm}`;
}

const isAllDay = (slot) => slot.start === 0 && slot.end === 1440;
const showsRange = (gran) => gran > 30;

/** Slot label in the event's own (canonical) zone. */
function slotLabel(slot, gran) {
  if (isAllDay(slot)) return "All day";
  return showsRange(gran)
    ? `${fmtMinutes(slot.start)} – ${fmtMinutes(slot.end)}`
    : fmtMinutes(slot.start);
}

/** Wall-clock (date, minutes) in `tz` → exact instant. Handles minutes >= 1440. */
function slotInstant(date, minutes, tz) {
  const base = DateTime.fromISO(date, { zone: tz }).plus({ days: Math.floor(minutes / 1440) });
  const m = minutes % 1440;
  return DateTime.fromObject(
    { year: base.year, month: base.month, day: base.day, hour: Math.floor(m / 60), minute: m % 60 },
    { zone: tz },
  );
}

/**
 * The slot re-labelled into the viewer's zone, computed for THIS date's real
 * instant (so it is exact across DST). Returns { text, shift }.
 */
function viewerLabel(date, slot, gran, eventTz, viewTz) {
  const a = slotInstant(date, slot.start, eventTz).setZone(viewTz);
  let text;
  if (isAllDay(slot) || showsRange(gran)) {
    const b = slotInstant(date, slot.end, eventTz).setZone(viewTz);
    text = `${a.toFormat("h:mm a")} – ${b.toFormat("h:mm a")}`;
  } else {
    text = a.toFormat("h:mm a");
  }
  const localDate = a.toISODate();
  const shift = localDate === date ? "" : localDate > date ? "next day" : "previous day";
  return { text, shift, localDate: a.toFormat("ccc, LLL d") };
}

const fmtDateShort = (iso) => DateTime.fromISO(iso).toFormat("ccc LLL d");
const fmtDateLong = (iso) => DateTime.fromISO(iso).toFormat("cccc, LLLL d, yyyy");
const tzAbbrev = (tz, date) => DateTime.fromISO(date, { zone: tz }).toFormat("ZZZZ");

/** Events expire (client-side lazy check) 15 days after end_date, in the event zone. */
function isExpired(row) {
  const cutoff = DateTime.fromISO(row.end_date, { zone: row.tz }).plus({ days: RETENTION_DAYS + 1 });
  return DateTime.now() >= cutoff;
}

function genCode() {
  const arr = new Uint32Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
}

/** "Alex" → "Alex (2)" if taken by someone else (case-insensitive). */
function dedupeName(name, otherNames) {
  const base = name.trim();
  const taken = new Set(otherNames.filter(Boolean).map((n) => n.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`.toLowerCase())) n += 1;
  return `${base} (${n})`;
}

/** CSV cell with quoting + spreadsheet formula-injection protection. */
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* =====================================================================
 * Config model (shared by Create and Edit)
 * ===================================================================== */
function defaultConfig() {
  const t = todayISO();
  return {
    name: "",
    dateMode: "range",
    startDate: t,
    endDate: addDaysISO(t, 6),
    dates: [],
    tz: browserTz(),
    startHour: 9,
    endHour: 17,
    granChoice: "30",
    customGran: "45",
    deadlineOn: false,
    deadlineLocal: "",
    anonymous: false,
  };
}

function configFromRow(row) {
  const preset = PRESET_GRANS.some((p) => p.value === row.granularity);
  return {
    name: row.name,
    dateMode: row.date_mode,
    startDate: row.start_date,
    endDate: row.end_date,
    dates: row.date_mode === "custom" ? [...row.dates].sort() : [],
    tz: row.tz,
    startHour: row.start_hour,
    endHour: row.end_hour,
    granChoice: preset ? String(row.granularity) : "custom",
    customGran: preset ? "45" : String(row.granularity),
    deadlineOn: !!row.deadline,
    deadlineLocal: row.deadline
      ? DateTime.fromISO(row.deadline).setZone(row.tz).toFormat("yyyy-LL-dd'T'HH:mm")
      : "",
    anonymous: !!row.anonymous,
  };
}

function validateCustomGran(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return { ok: false, msg: "Enter a slot size in minutes." };
  if (!/^\d+$/.test(s)) return { ok: false, msg: "Use a whole number of minutes (no decimals, signs, or letters)." };
  const n = parseInt(s, 10);
  if (n < 5) return { ok: false, msg: "Slot size must be at least 5 minutes." };
  if (n > 1440) return { ok: false, msg: "Slot size can't be more than 1440 minutes (24 hours)." };
  return { ok: true, value: n };
}

function effectiveGran(cfg) {
  if (cfg.granChoice === "custom") {
    const v = validateCustomGran(cfg.customGran);
    return v.ok ? v.value : null;
  }
  return parseInt(cfg.granChoice, 10);
}

function validateConfig(cfg) {
  if (!cfg.name.trim()) return "Give the event a name.";
  const gran = effectiveGran(cfg);
  if (!gran) return "Fix the custom slot size before continuing.";
  if (cfg.dateMode === "range") {
    if (!cfg.startDate || !cfg.endDate) return "Pick a start and end date.";
    if (cfg.endDate < cfg.startDate) return "End date can't be before the start date.";
    if (daysBetween(cfg.startDate, cfg.endDate) + 1 > MAX_RANGE_DAYS)
      return `Date ranges are limited to ${MAX_RANGE_DAYS} days.`;
  } else {
    if (cfg.dates.length < 1) return "Pick at least one date.";
    if (cfg.dates.length > MAX_CUSTOM_DATES) return `You can pick up to ${MAX_CUSTOM_DATES} dates.`;
  }
  if (gran !== 1440 && cfg.endHour <= cfg.startHour) return "The daily end time must be after the start time.";
  if (cfg.deadlineOn && !cfg.deadlineLocal) return "Choose a deadline date and time, or turn the deadline off.";
  if (!cfg.tz) return "Choose a time zone.";
  return null;
}

function rowFromConfig(cfg) {
  const gran = effectiveGran(cfg);
  const whole = gran === 1440;
  let start_date, end_date, dates;
  if (cfg.dateMode === "custom") {
    const sorted = [...cfg.dates].sort();
    start_date = sorted[0];
    end_date = sorted[sorted.length - 1];
    dates = sorted;
  } else {
    start_date = cfg.startDate;
    end_date = cfg.endDate;
    dates = [];
  }
  return {
    name: cfg.name.trim(),
    tz: cfg.tz,
    date_mode: cfg.dateMode,
    start_date,
    end_date,
    dates,
    start_hour: whole ? 0 : cfg.startHour,
    end_hour: whole ? 24 : cfg.endHour,
    granularity: gran,
    deadline:
      cfg.deadlineOn && cfg.deadlineLocal
        ? DateTime.fromISO(cfg.deadlineLocal, { zone: cfg.tz }).toUTC().toISO()
        : null,
    anonymous: !!cfg.anonymous,
  };
}

/** All valid slot keys for an event row. */
function keysForRow(row) {
  const keys = new Set();
  const slots = buildSlots(row.start_hour, row.end_hour, row.granularity);
  for (const d of datesFromRow(row)) for (const s of slots) keys.add(slotKey(d, s.start));
  return keys;
}

/* =====================================================================
 * Small accessible building blocks
 * ===================================================================== */
function Spinner({ label = "Loading" }) {
  return (
    <span className="inline-flex items-center gap-2 text-gray-700" role="status">
      <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
      <span>{label}…</span>
    </span>
  );
}

function Toast({ toast }) {
  // The live region is ALWAYS mounted so screen readers announce changes
  // without focus moving.
  const tone =
    toast?.tone === "error"
      ? "border-red-700 bg-red-50 text-red-900"
      : toast?.tone === "success"
        ? "border-emerald-700 bg-emerald-50 text-emerald-900"
        : "border-gray-500 bg-white text-gray-900";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
    >
      {toast && (
        <div key={toast.id} className={`pointer-events-auto max-w-lg rounded-lg border px-4 py-3 text-sm shadow-lg ${tone}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Modal({ title, onClose, children, footer }) {
  const ref = useRef(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement;
    const node = ref.current;
    const focusables = () =>
      Array.from(
        node.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    const first = node.querySelector("[data-autofocus]") || focusables()[0] || node;
    first.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const a = f[0];
        const z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    node.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      node.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (prev && typeof prev.focus === "function") prev.focus(); // return focus to trigger
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-2xl rounded-xl bg-white shadow-xl focus:outline-none"
      >
        <div className="flex items-center justify-between border-b border-gray-300 px-5 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className={`${BTN} p-2 text-gray-800 hover:bg-gray-100`} aria-label="Close dialog">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-gray-300 px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}

/* =====================================================================
 * Mini calendar (specific-dates mode)
 * ===================================================================== */
function MiniCalendar({ selected, onToggle, idPrefix }) {
  const today = todayISO();
  const [month, setMonth] = useState(() => DateTime.fromISO(selected[0] || today).startOf("month"));
  const sel = useMemo(() => new Set(selected), [selected]);
  const earliest = selected[0] && selected[0] < today ? selected[0] : today;
  const thisMonth = DateTime.fromISO(earliest).startOf("month");

  const cells = useMemo(() => {
    const start = month.startOf("month");
    const lead = start.weekday % 7; // Sunday-first grid (Luxon: Mon=1..Sun=7)
    const out = Array.from({ length: lead }, () => null);
    for (let d = 0; d < month.daysInMonth; d += 1) out.push(start.plus({ days: d }).toISODate());
    return out;
  }, [month]);

  const titleId = `${idPrefix}-cal-title`;
  return (
    <div className="rounded-lg border border-gray-400 p-3">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          className={`${BTN} p-1.5 text-gray-900 hover:bg-gray-100`}
          onClick={() => setMonth((m) => m.minus({ months: 1 }))}
          disabled={month <= thisMonth}
          aria-label="Previous month"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <p id={titleId} className="text-sm font-semibold text-gray-900" aria-live="polite">
          {month.toFormat("LLLL yyyy")}
        </p>
        <button
          type="button"
          className={`${BTN} p-1.5 text-gray-900 hover:bg-gray-100`}
          onClick={() => setMonth((m) => m.plus({ months: 1 }))}
          aria-label="Next month"
        >
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-gray-700" aria-hidden="true">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1" role="group" aria-labelledby={titleId}>
        {cells.map((iso, i) => {
          if (!iso) return <div key={`b${i}`} />;
          const on = sel.has(iso);
          const past = iso < today && !on; // past dates already picked (edit mode) can still be removed
          return (
            <button
              key={iso}
              type="button"
              disabled={past}
              aria-pressed={on}
              aria-label={fmtDateLong(iso)}
              onClick={() => onToggle(iso)}
              className={`h-9 rounded-md text-sm ${FOCUS} ${
                on
                  ? "bg-indigo-700 font-semibold text-white"
                  : past
                    ? "cursor-not-allowed text-gray-400"
                    : "text-gray-900 hover:bg-indigo-50"
              }`}
            >
              {DateTime.fromISO(iso).day}
              {on && <span className="sr-only"> (selected)</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* =====================================================================
 * Config form (Create + Edit share this)
 * ===================================================================== */
function ConfigForm({ cfg, setCfg, idPrefix, onToast }) {
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const gran = effectiveGran(cfg);
  const whole = gran === 1440;
  const customV = validateCustomGran(cfg.customGran);
  const today = todayISO();
  const id = (s) => `${idPrefix}-${s}`;
  const tzOptions = TZ_LIST.includes(cfg.tz) ? TZ_LIST : [cfg.tz, ...TZ_LIST];

  const toggleDate = (iso) => {
    setCfg((c) => {
      const has = c.dates.includes(iso);
      if (!has && c.dates.length >= MAX_CUSTOM_DATES) {
        onToast?.(`You can pick up to ${MAX_CUSTOM_DATES} dates.`, "error");
        return c;
      }
      return { ...c, dates: has ? c.dates.filter((d) => d !== iso) : [...c.dates, iso].sort() };
    });
  };

  const onStartChange = (s) => {
    if (!s) return set({ startDate: s });
    let end = cfg.endDate;
    if (!end || end < s) end = s; // end follows start forward — never inverts
    if (daysBetween(s, end) + 1 > MAX_RANGE_DAYS) end = addDaysISO(s, MAX_RANGE_DAYS - 1);
    set({ startDate: s, endDate: end });
  };

  const snapCustom = () => {
    const s = String(cfg.customGran).trim();
    if (!/^\d+$/.test(s)) return; // leave invalid text for the error message
    const snapped = Math.min(1440, Math.max(5, Math.round(parseInt(s, 10) / 5) * 5));
    set({ customGran: String(snapped) });
  };

  const hrs = (n) => (n >= 60 ? ` (${+(n / 60).toFixed(2)} hr)` : "");

  return (
    <div className="space-y-5">
      <div>
        <label htmlFor={id("name")} className={LABEL}>Event name <span aria-hidden="true">*</span></label>
        <input
          id={id("name")}
          className={INPUT}
          value={cfg.name}
          maxLength={120}
          required
          aria-required="true"
          onChange={(e) => set({ name: e.target.value })}
          placeholder="e.g. Quarterly planning"
          data-autofocus
        />
      </div>

      <fieldset>
        <legend className={LABEL}>Dates</legend>
        <div className="mb-3 inline-flex rounded-lg border border-gray-500 p-1">
          {[
            ["range", "Date range"],
            ["custom", "Specific dates"],
          ].map(([v, label]) => (
            <label
              key={v}
              className={`cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium focus-within:ring-2 focus-within:ring-indigo-700 ${
                cfg.dateMode === v ? "bg-indigo-700 text-white" : "text-gray-900 hover:bg-gray-100"
              }`}
            >
              <input
                type="radio"
                name={id("datemode")}
                value={v}
                checked={cfg.dateMode === v}
                onChange={() => set({ dateMode: v })}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>

        {cfg.dateMode === "range" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={id("start")} className={LABEL}>Start date</label>
              <input
                id={id("start")}
                type="date"
                className={INPUT}
                value={cfg.startDate}
                min={today}
                onChange={(e) => onStartChange(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={id("end")} className={LABEL}>End date</label>
              <input
                id={id("end")}
                type="date"
                className={INPUT}
                value={cfg.endDate}
                min={cfg.startDate}
                max={cfg.startDate ? addDaysISO(cfg.startDate, MAX_RANGE_DAYS - 1) : undefined}
                aria-describedby={id("end-help")}
                onChange={(e) => set({ endDate: e.target.value })}
              />
              <p id={id("end-help")} className="mt-1 text-xs text-gray-700">Inclusive. Up to {MAX_RANGE_DAYS} days.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <MiniCalendar selected={cfg.dates} onToggle={toggleDate} idPrefix={idPrefix} />
            <div className="flex items-center justify-between text-sm text-gray-800">
              <span aria-live="polite">
                {cfg.dates.length} of {MAX_CUSTOM_DATES} dates selected
              </span>
              {cfg.dates.length > 0 && (
                <button type="button" className={`${FOCUS} rounded text-indigo-800 underline`} onClick={() => set({ dates: [] })}>
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </fieldset>

      <div>
        <label htmlFor={id("tz")} className={LABEL}>Event time zone</label>
        <select id={id("tz")} className={INPUT} value={cfg.tz} onChange={(e) => set({ tz: e.target.value })} aria-describedby={id("tz-help")}>
          {tzOptions.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
        </select>
        <p id={id("tz-help")} className="mt-1 text-xs text-gray-700">
          Slots are defined in this zone. Each viewer can relabel times into their own zone.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={id("gran")} className={LABEL}>Slot size</label>
          <select id={id("gran")} className={INPUT} value={cfg.granChoice} onChange={(e) => set({ granChoice: e.target.value })}>
            {PRESET_GRANS.map((p) => <option key={p.value} value={String(p.value)}>{p.label}</option>)}
            <option value="custom">Custom…</option>
          </select>
        </div>
        <div>
          <label htmlFor={id("from")} className={LABEL}>From</label>
          <select
            id={id("from")}
            className={INPUT}
            value={whole ? 0 : cfg.startHour}
            disabled={whole}
            onChange={(e) => set({ startHour: parseInt(e.target.value, 10) })}
          >
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={id("to")} className={LABEL}>To</label>
          <select
            id={id("to")}
            className={INPUT}
            value={whole ? 24 : cfg.endHour}
            disabled={whole}
            onChange={(e) => set({ endHour: parseInt(e.target.value, 10) })}
          >
            {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
          </select>
        </div>
      </div>
      {whole && <p className="-mt-3 text-xs text-gray-700">Whole-day slots cover midnight to midnight, so the hour pickers are disabled.</p>}

      {cfg.granChoice === "custom" && (
        <div>
          <label htmlFor={id("custom")} className={LABEL}>Custom slot size (minutes)</label>
          <input
            id={id("custom")}
            type="number"
            inputMode="numeric"
            min={5}
            max={1440}
            step={5}
            className={`${INPUT} ${customV.ok ? "" : "border-red-700 bg-red-50 ring-1 ring-red-700"}`}
            value={cfg.customGran}
            aria-invalid={!customV.ok}
            aria-describedby={`${id("custom-msg")} ${id("custom-help")}`}
            onChange={(e) => set({ customGran: e.target.value })}
            onBlur={snapCustom}
          />
          <p id={id("custom-help")} className="mt-1 text-xs text-gray-700">5–1440 minutes; snaps to nearest 5 min when you leave the field.</p>
          <p id={id("custom-msg")} className={`mt-1 flex items-center gap-1 text-sm ${customV.ok ? "text-emerald-800" : "text-red-800"}`}>
            {customV.ok ? <Check className="h-4 w-4" aria-hidden="true" /> : <X className="h-4 w-4" aria-hidden="true" />}
            {customV.ok
              ? customV.value === 1440
                ? "Whole-day slots"
                : `${customV.value}-minute slots${hrs(customV.value)}`
              : <span><span className="sr-only">Error: </span>{customV.msg}</span>}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            id={id("deadline-on")}
            type="checkbox"
            className={`h-4 w-4 rounded border-gray-600 text-indigo-700 ${FOCUS}`}
            checked={cfg.deadlineOn}
            onChange={(e) => set({ deadlineOn: e.target.checked })}
          />
          <label htmlFor={id("deadline-on")} className="text-sm font-medium text-gray-900">Set a response deadline</label>
        </div>
        {cfg.deadlineOn && (
          <div>
            <label htmlFor={id("deadline")} className={LABEL}>Responses close at ({cfg.tz.replace(/_/g, " ")} time)</label>
            <input
              id={id("deadline")}
              type="datetime-local"
              className={INPUT}
              value={cfg.deadlineLocal}
              onChange={(e) => set({ deadlineLocal: e.target.value })}
            />
          </div>
        )}
      </div>

      <div className="flex items-start gap-2">
        <input
          id={id("anon")}
          type="checkbox"
          className={`mt-0.5 h-4 w-4 rounded border-gray-600 text-indigo-700 ${FOCUS}`}
          checked={cfg.anonymous}
          aria-describedby={id("anon-help")}
          onChange={(e) => set({ anonymous: e.target.checked })}
        />
        <div>
          <label htmlFor={id("anon")} className="text-sm font-medium text-gray-900">Hide respondent names from non-organizers</label>
          <p id={id("anon-help")} className="text-xs text-gray-700">Others see counts only. Names are removed on the server, not just hidden in the page.</p>
        </div>
      </div>
    </div>
  );
}

/* =====================================================================
 * Home screen (create / join)
 * ===================================================================== */
function Home({ onCreate, onJoin, toast }) {
  const [cfg, setCfg] = useState(defaultConfig);
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submitCreate = async (e) => {
    e.preventDefault();
    const err = validateConfig(cfg);
    if (err) return toast(err, "error");
    setBusy(true);
    await onCreate(cfg);
    setBusy(false);
  };

  const submitJoin = (e) => {
    e.preventDefault();
    const c = joinCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(c)) return toast("Event codes are 6 letters or numbers.", "error");
    onJoin(c);
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_20rem]">
      <section aria-labelledby="create-h" className="rounded-xl border border-gray-300 bg-white p-5 shadow-sm">
        <h2 id="create-h" className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900">
          <Calendar className="h-5 w-5" aria-hidden="true" /> Create an event
        </h2>
        <form onSubmit={submitCreate} noValidate>
          <ConfigForm cfg={cfg} setCfg={setCfg} idPrefix="create" onToast={toast} />
          <div className="mt-6">
            <button type="submit" className={BTN_PRIMARY} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
              Create event
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="join-h" className="h-fit rounded-xl border border-gray-300 bg-white p-5 shadow-sm">
        <h2 id="join-h" className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900">
          <Users className="h-5 w-5" aria-hidden="true" /> Join an event
        </h2>
        <form onSubmit={submitJoin}>
          <label htmlFor="join-code" className={LABEL}>Event code</label>
          <input
            id="join-code"
            className={`${INPUT} font-mono uppercase tracking-widest`}
            value={joinCode}
            maxLength={6}
            autoComplete="off"
            aria-describedby="join-help"
            onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            placeholder="K7P2QX"
          />
          <p id="join-help" className="mt-1 text-xs text-gray-700">6 characters, from the organizer.</p>
          <button type="submit" className={`${BTN_SECONDARY} mt-4 w-full`}>Join</button>
        </form>
      </section>
    </div>
  );
}

/* =====================================================================
 * Event view
 * ===================================================================== */
function EventView({ code, userId, onLeave, toast }) {
  const [event, setEvent] = useState(null);
  const [subs, setSubs] = useState([]);
  const [mine, setMine] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("mine");
  const [viewTz, setViewTz] = useState(browserTz);
  const [myName, setMyName] = useState("");
  const [mySel, setMySel] = useState(() => new Set());
  const [selectedDate, setSelectedDate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [finalizeMode, setFinalizeMode] = useState(false);
  const [finalDraft, setFinalDraft] = useState(() => new Set());
  const [showEdit, setShowEdit] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [activeCell, setActiveCell] = useState(null);
  const [now, setNow] = useState(() => DateTime.now());
  const nameRef = useRef(null);

  const isOrganizer = !!event && event.owner_id === userId;
  const canSeeNames = isOrganizer || (event && !event.anonymous);

  /* ---------- data loading ---------- */
  const loadSubs = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_event_submissions", { p_code: code });
    if (!error) setSubs(data || []);
  }, [code]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const { data: ev, error } = await supabase.from("events").select("*").eq("code", code).maybeSingle();
      if (!alive) return;
      if (error) return onLeave(`Couldn't load event: ${error.message}`);
      if (!ev) return onLeave(`No event found with code ${code}.`);
      if (isExpired(ev)) return onLeave("This event has expired and is no longer available.");
      setEvent(ev);
      const [{ data: own }] = await Promise.all([
        supabase.from("submissions").select("*").eq("event_code", code).eq("user_id", userId).maybeSingle(),
        loadSubs(),
      ]);
      if (!alive) return;
      if (own) {
        setMine(own);
        setMyName(own.name);
        setMySel(new Set(own.slots || []));
      }
      setSelectedDate(datesFromRow(ev)[0]);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [code, userId, loadSubs, onLeave]);

  // Clock tick so the deadline lock engages without a reload.
  useEffect(() => {
    const t = setInterval(() => setNow(DateTime.now()), 30000);
    return () => clearInterval(t);
  }, []);

  /* ---------- realtime / polling ---------- */
  const eventLoaded = !!event;
  const anonymous = !!event?.anonymous;
  useEffect(() => {
    if (!eventLoaded) return undefined;
    const liveSubs = !anonymous || isOrganizer;
    const ch = supabase
      .channel(`evt-${code}-${userId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "events", filter: `code=eq.${code}` }, (p) => {
        if (p.new) setEvent(p.new);
      })
      // DELETE events can't be filtered server-side; only PKs are sent, so reloading is safe.
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "submissions" }, () => loadSubs());
    if (liveSubs) {
      ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "submissions", filter: `event_code=eq.${code}` }, () => loadSubs());
      ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "submissions", filter: `event_code=eq.${code}` }, () => loadSubs());
    }
    ch.subscribe();
    const timer = liveSubs ? null : setInterval(loadSubs, POLL_MS);
    return () => {
      supabase.removeChannel(ch);
      if (timer) clearInterval(timer);
    };
  }, [code, userId, eventLoaded, anonymous, isOrganizer, loadSubs]);

  /* ---------- derived ---------- */
  const dates = useMemo(() => (event ? datesFromRow(event) : []), [event]);
  const gran = event?.granularity || 30;
  const slots = useMemo(() => (event ? buildSlots(event.start_hour, event.end_hour, event.granularity) : []), [event]);
  const validKeys = useMemo(() => (event ? keysForRow(event) : new Set()), [event]);
  const tzDiffers = event && viewTz !== event.tz;

  useEffect(() => {
    if (dates.length && !dates.includes(selectedDate)) setSelectedDate(dates[0]);
  }, [dates, selectedDate]);

  const agg = useMemo(() => {
    const map = new Map();
    for (const s of subs) {
      for (const k of s.slots || []) {
        if (!validKeys.has(k)) continue; // grid shrank after edit → drop from display
        const cur = map.get(k) || { count: 0, names: [] };
        cur.count += 1;
        if (s.name) cur.names.push(s.name);
        map.set(k, cur);
      }
    }
    return map;
  }, [subs, validKeys]);

  const total = subs.length;
  const maxCount = useMemo(() => Math.max(0, ...Array.from(agg.values(), (v) => v.count)), [agg]);
  const best = useMemo(() => {
    if (!maxCount) return [];
    const out = [];
    for (const d of dates) for (const s of slots) {
      const k = slotKey(d, s.start);
      if (agg.get(k)?.count === maxCount) out.push({ date: d, slot: s, key: k, names: agg.get(k).names });
    }
    return out;
  }, [agg, maxCount, dates, slots]);

  const finalized = useMemo(
    () => new Set((event?.finalized || []).filter((k) => validKeys.has(k))),
    [event, validKeys],
  );
  const deadline = event?.deadline ? DateTime.fromISO(event.deadline) : null;
  const closed = !!deadline && now > deadline;
  const lockedForMe = closed && !isOrganizer;

  const slotByKey = useMemo(() => {
    const m = new Map();
    for (const d of dates) for (const s of slots) m.set(slotKey(d, s.start), { date: d, slot: s });
    return m;
  }, [dates, slots]);

  /* ---------- labels ---------- */
  const rowViewerLabel = useCallback(
    (slot) => {
      if (!tzDiffers) return null;
      // DST-safe: compute for EVERY date and dedupe; never a representative date.
      const seen = [];
      for (const d of dates) {
        const { text, shift } = viewerLabel(d, slot, gran, event.tz, viewTz);
        const t = shift ? `${text} (${shift})` : text;
        if (!seen.includes(t)) seen.push(t);
      }
      return seen.join(" / ");
    },
    [tzDiffers, dates, gran, event, viewTz],
  );

  const describeKey = useCallback(
    (key) => {
      const hit = slotByKey.get(key);
      if (!hit) return key;
      const { date, slot } = hit;
      const ev = `${fmtDateShort(date)} · ${slotLabel(slot, gran)} ${tzAbbrev(event.tz, date)}`;
      if (!tzDiffers) return ev;
      const v = viewerLabel(date, slot, gran, event.tz, viewTz);
      return `${ev} (your time: ${v.localDate}, ${v.text} ${tzAbbrev(viewTz, date)})`;
    },
    [slotByKey, gran, event, tzDiffers, viewTz],
  );

  /* ---------- my availability actions ---------- */
  const applyKey = useCallback((key, on) => {
    setMySel((prev) => {
      if (prev.has(key) === on) return prev;
      const n = new Set(prev);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });
  }, []);

  const submit = async () => {
    if (lockedForMe) return;
    if (!myName.trim()) {
      toast("Enter your name before submitting.", "error");
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    const others = subs.filter((s) => !s.is_mine).map((s) => s.name);
    // Names of others are only readable when canSeeNames; on anonymous events
    // (non-organizer) collisions can't be detected client-side — see Gotchas.
    const finalName = canSeeNames ? dedupeName(myName, others) : myName.trim();
    const slotsArr = [...mySel].filter((k) => validKeys.has(k)).sort();
    const { data, error } = await supabase
      .from("submissions")
      .upsert({ event_code: code, user_id: userId, name: finalName, slots: slotsArr }, { onConflict: "event_code,user_id" })
      .select()
      .single();
    setSaving(false);
    if (error) {
      toast(
        /Responses are closed/i.test(error.message) ? "Responses are closed for this event." : `Couldn't save: ${error.message}`,
        "error",
      );
      return;
    }
    const wasUpdate = !!mine;
    setMine(data);
    setMyName(finalName);
    if (finalName !== myName.trim()) toast(`That name is already in use, so you were saved as "${finalName}".`);
    else toast(wasUpdate ? "Availability updated." : "Availability submitted.", "success");
    await loadSubs();
    setTab("group");
  };

  const withdraw = async () => {
    if (!mine) return;
    if (!window.confirm("Withdraw your response? This removes your availability from the group.")) return;
    const { error } = await supabase.from("submissions").delete().eq("id", mine.id);
    if (error) return toast(`Couldn't withdraw: ${error.message}`, "error");
    setMine(null);
    setMySel(new Set());
    toast("Your response was withdrawn.", "success");
    loadSubs();
  };

  /* ---------- organizer actions ---------- */
  const removeSub = async (s) => {
    const who = s.name || "this respondent";
    if (!window.confirm(`Remove the response from ${who}?`)) return;
    const { error } = await supabase.from("submissions").delete().eq("id", s.id);
    if (error) return toast(`Couldn't remove: ${error.message}`, "error");
    if (s.is_mine) {
      setMine(null);
      setMySel(new Set());
    }
    toast(`Removed ${who}.`, "success");
    loadSubs();
  };

  const startFinalize = () => {
    setFinalDraft(new Set(finalized));
    setFinalizeMode(true);
  };

  const saveFinal = async () => {
    const arr = [...finalDraft].filter((k) => validKeys.has(k)).sort();
    const { data, error } = await supabase.from("events").update({ finalized: arr }).eq("code", code).select().single();
    if (error) return toast(`Couldn't save final times: ${error.message}`, "error");
    setEvent(data);
    setFinalizeMode(false);
    toast(arr.length ? `Confirmed ${arr.length} time${arr.length === 1 ? "" : "s"}.` : "Cleared confirmed times.", "success");
  };

  const saveEdit = async (cfg) => {
    const err = validateConfig(cfg);
    if (err) {
      toast(err, "error");
      return false;
    }
    const row = rowFromConfig(cfg);
    const newKeys = keysForRow(row);
    row.finalized = (event.finalized || []).filter((k) => newKeys.has(k)); // prune finals outside new grid
    const { data, error } = await supabase.from("events").update(row).eq("code", code).select().single();
    if (error) {
      toast(`Couldn't save changes: ${error.message}`, "error");
      return false;
    }
    setEvent(data);
    toast("Event updated.", "success");
    return true;
  };

  /* ---------- export / copy ---------- */
  const copyText = async (text, okMsg) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg, "success");
    } catch {
      toast("Couldn't access the clipboard.", "error");
    }
  };

  const copyBest = () => {
    if (!best.length) return;
    const lines = [`${event.name} — best overlap (${maxCount} of ${total} available)`, ""];
    for (const b of best) {
      lines.push(`• ${describeKey(b.key)}`);
      if (canSeeNames && b.names.length) lines.push(`    ${b.names.join(", ")}`);
    }
    copyText(lines.join("\n"), "Best times copied.");
  };

  const exportCsv = (cols) => {
    const includeNames = cols.names && isOrganizer; // forced anonymization for non-organizers
    const header = [];
    if (cols.date) header.push("Date");
    if (cols.time) header.push(`Time (${event.tz})`);
    if (cols.yourTime) header.push(`Time (${viewTz})`);
    if (cols.free) header.push("People free");
    if (cols.total) header.push("Total responders");
    if (includeNames) header.push("Names");
    const rows = [header.map(csvCell).join(",")];
    for (const d of dates) for (const s of slots) {
      const k = slotKey(d, s.start);
      const a = agg.get(k) || { count: 0, names: [] };
      const r = [];
      if (cols.date) r.push(d);
      if (cols.time) r.push(slotLabel(s, gran));
      if (cols.yourTime) {
        const v = viewerLabel(d, s, gran, event.tz, viewTz);
        r.push(v.shift ? `${v.text} (${v.shift})` : v.text);
      }
      if (cols.free) r.push(a.count);
      if (cols.total) r.push(total);
      if (includeNames) r.push(a.names.join("; "));
      rows.push(r.map(csvCell).join(","));
    }
    const blob = new Blob([rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `availability-${code}${includeNames ? "" : "-anonymized"}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("CSV downloaded.", "success");
  };

  /* ---------- render ---------- */
  if (loading || !event) {
    return (
      <div className="mx-auto max-w-5xl rounded-xl border border-gray-300 bg-white p-8 text-center">
        <Spinner label="Loading event" />
      </div>
    );
  }

  const tzOptions = TZ_LIST.includes(viewTz) ? TZ_LIST : [viewTz, ...TZ_LIST];
  const dateSummary =
    event.date_mode === "custom"
      ? `${dates.length} specific date${dates.length === 1 ? "" : "s"}`
      : `${fmtDateShort(event.start_date)} – ${fmtDateShort(event.end_date)}`;
  const hoursSummary = gran === 1440 ? "Whole-day slots" : `${fmtHour(event.start_hour).split(" (")[0]}–${fmtHour(event.end_hour).split(" (")[0]} · ${gran}-min slots`;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {/* Header */}
      <section className="rounded-xl border border-gray-300 bg-white p-5 shadow-sm" aria-labelledby="event-title">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <button type="button" onClick={() => onLeave()} className={`${FOCUS} mb-2 inline-flex items-center gap-1 rounded text-sm text-indigo-800 underline`}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All events
            </button>
            <h2 id="event-title" className="flex flex-wrap items-center gap-2 text-xl font-semibold text-gray-900">
              {event.name}
              {isOrganizer && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                  <Crown className="h-3.5 w-3.5" aria-hidden="true" /> Organizer
                </span>
              )}
              {event.anonymous && (
                <span className="inline-flex items-center gap-1 rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-900">
                  <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> Names hidden
                </span>
              )}
            </h2>
            <p className="mt-1 text-sm text-gray-700">
              {dateSummary} · {hoursSummary} · {event.tz.replace(/_/g, " ")}
            </p>
            {deadline && (
              <p className={`mt-1 flex items-center gap-1 text-sm ${closed ? "text-red-800" : "text-gray-700"}`}>
                <Clock className="h-4 w-4" aria-hidden="true" />
                {closed ? "Responses closed" : "Responses close"} {deadline.setZone(viewTz).toFormat("ccc LLL d, h:mm a ZZZZ")}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-gray-400 bg-gray-50 px-3 py-1.5">
              <span className="text-xs text-gray-700">Code</span>
              <span className="font-mono text-base font-semibold tracking-widest text-gray-900">{code}</span>
              <button type="button" className={`${BTN} p-1 text-gray-800 hover:bg-gray-200`} aria-label={`Copy event code ${code}`} onClick={() => copyText(code, "Event code copied.")}>
                <Copy className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {isOrganizer && (
              <button type="button" className={BTN_SECONDARY} onClick={() => setShowEdit(true)}>
                <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
              </button>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Globe className="h-4 w-4 text-gray-700" aria-hidden="true" />
          <label htmlFor="view-tz" className="text-sm text-gray-900">Showing times in</label>
          <select id="view-tz" className={`${INPUT} w-auto`} value={viewTz} onChange={(e) => setViewTz(e.target.value)}>
            {tzOptions.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
          </select>
        </div>
      </section>

      {/* Confirmed times banner */}
      {finalized.size > 0 && (
        <section className="rounded-xl border border-emerald-700 bg-emerald-50 p-4" aria-labelledby="confirmed-h">
          <h2 id="confirmed-h" className="flex items-center gap-2 font-semibold text-emerald-900">
            <Star className="h-5 w-5" aria-hidden="true" /> Confirmed time{finalized.size === 1 ? "" : "s"}
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-emerald-950">
            {[...finalized].sort().map((k) => <li key={k}>{describeKey(k)}</li>)}
          </ul>
        </section>
      )}

      {/* Tabs */}
      <Tabs tab={tab} setTab={setTab} hasMine={!!mine} />

      {tab === "mine" ? (
        <div role="tabpanel" id="panel-mine" aria-labelledby="tab-mine" tabIndex={0} className={`rounded-xl border border-gray-300 bg-white p-5 shadow-sm ${FOCUS}`}>
          {closed && (
            <div className={`mb-4 flex items-start gap-2 rounded-lg border p-3 text-sm ${lockedForMe ? "border-red-700 bg-red-50 text-red-900" : "border-amber-700 bg-amber-50 text-amber-900"}`}>
              <Lock className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
              <p>
                {lockedForMe
                  ? "Responses are closed. You can still view the group overlap."
                  : "Responses are closed for respondents. As organizer you can still edit your own entry."}
              </p>
            </div>
          )}
          <AvailabilityEntry
            event={event}
            dates={dates}
            slots={slots}
            gran={gran}
            viewTz={viewTz}
            tzDiffers={tzDiffers}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            mySel={mySel}
            setMySel={setMySel}
            applyKey={applyKey}
            locked={lockedForMe}
            myName={myName}
            setMyName={setMyName}
            nameRef={nameRef}
          />
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={saving || lockedForMe}>
              {saving ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
              {mine ? "Update availability" : "Submit availability"}
            </button>
            {mine && (
              <button type="button" className={BTN_DANGER} onClick={withdraw} disabled={saving || lockedForMe}>
                <Trash2 className="h-4 w-4" aria-hidden="true" /> Withdraw
              </button>
            )}
            <span className="text-sm text-gray-700">{mySel.size} slot{mySel.size === 1 ? "" : "s"} selected in total</span>
          </div>
        </div>
      ) : (
        <div role="tabpanel" id="panel-group" aria-labelledby="tab-group" className="space-y-4">
          <section className="rounded-xl border border-gray-300 bg-white p-5 shadow-sm" aria-labelledby="heat-h">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="heat-h" className="text-lg font-semibold text-gray-900">
                Group overlap <span className="text-sm font-normal text-gray-700">({total} response{total === 1 ? "" : "s"})</span>
              </h2>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={BTN_SECONDARY} onClick={loadSubs}>
                  <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
                </button>
                {total > 0 && (
                  <>
                    <button type="button" className={BTN_SECONDARY} onClick={copyBest} disabled={!best.length}>
                      <ClipboardCopy className="h-4 w-4" aria-hidden="true" /> Copy best
                    </button>
                    <button type="button" className={BTN_SECONDARY} onClick={() => setShowExport(true)}>
                      <Download className="h-4 w-4" aria-hidden="true" /> Export
                    </button>
                  </>
                )}
                {isOrganizer && !finalizeMode && (
                  <button type="button" className={BTN_SECONDARY} onClick={startFinalize}>
                    <Star className="h-4 w-4" aria-hidden="true" /> Select final times
                  </button>
                )}
              </div>
            </div>

            {finalizeMode && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-700 bg-amber-50 p-3 text-sm text-amber-950">
                <p>
                  <strong>Finalize mode:</strong> activate cells to mark them as confirmed ({finalDraft.size} selected).
                </p>
                <div className="flex gap-2">
                  <button type="button" className={BTN_PRIMARY} onClick={saveFinal}>Save final times</button>
                  <button type="button" className={BTN_SECONDARY} onClick={() => setFinalizeMode(false)}>Cancel</button>
                </div>
              </div>
            )}

            {!anonymous || isOrganizer ? null : (
              <p className="mb-3 text-sm text-gray-700">The organizer has hidden names. You'll see counts only.</p>
            )}

            <Heatmap
              event={event}
              dates={dates}
              slots={slots}
              gran={gran}
              agg={agg}
              total={total}
              viewTz={viewTz}
              tzDiffers={tzDiffers}
              rowViewerLabel={rowViewerLabel}
              canSeeNames={canSeeNames}
              finalized={finalized}
              finalizeMode={finalizeMode}
              finalDraft={finalDraft}
              setFinalDraft={setFinalDraft}
              setActiveCell={setActiveCell}
            />

            <CellDetails
              activeCell={activeCell}
              agg={agg}
              total={total}
              gran={gran}
              event={event}
              viewTz={viewTz}
              tzDiffers={tzDiffers}
              canSeeNames={canSeeNames}
            />
          </section>

          <section className="rounded-xl border border-gray-300 bg-white p-5 shadow-sm" aria-labelledby="best-h">
            <h2 id="best-h" className="mb-2 text-lg font-semibold text-gray-900">Best overlap</h2>
            {best.length === 0 ? (
              <p className="text-sm text-gray-700">No responses yet.</p>
            ) : (
              <>
                <p className="mb-2 text-sm text-gray-800">
                  {maxCount} of {total} available at {best.length} time{best.length === 1 ? "" : "s"}:
                </p>
                <ul className="flex flex-wrap gap-2">
                  {best.slice(0, 12).map((b) => (
                    <li key={b.key} className="rounded-full border border-emerald-700 bg-emerald-50 px-3 py-1 text-sm text-emerald-950">
                      {describeKey(b.key)}
                    </li>
                  ))}
                  {best.length > 12 && <li className="px-2 py-1 text-sm text-gray-700">+{best.length - 12} more</li>}
                </ul>
              </>
            )}
          </section>

          {isOrganizer && (
            <section className="rounded-xl border border-gray-300 bg-white p-5 shadow-sm" aria-labelledby="manage-h">
              <h2 id="manage-h" className="mb-2 text-lg font-semibold text-gray-900">Manage responses</h2>
              {subs.length === 0 ? (
                <p className="text-sm text-gray-700">No responses yet.</p>
              ) : (
                <ul className="divide-y divide-gray-200">
                  {subs.map((s) => (
                    <li key={s.id} className="flex items-center justify-between py-2">
                      <span className="text-sm text-gray-900">
                        {s.name}
                        {s.is_mine && <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-900">you</span>}
                        <span className="ml-2 text-xs text-gray-700">{(s.slots || []).filter((k) => validKeys.has(k)).length} slots</span>
                      </span>
                      <button
                        type="button"
                        className={`${BTN} p-1.5 text-red-800 hover:bg-red-50`}
                        aria-label={`Remove response from ${s.name}`}
                        onClick={() => removeSub(s)}
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}

      {showEdit && (
        <EditModal event={event} onClose={() => setShowEdit(false)} onSave={saveEdit} toast={toast} />
      )}
      {showExport && (
        <ExportModal isOrganizer={isOrganizer} tzDiffers={tzDiffers} onClose={() => setShowExport(false)} onExport={exportCsv} />
      )}
    </div>
  );
}

/* ---------- Tabs (WAI-ARIA tabs pattern) ---------- */
function Tabs({ tab, setTab, hasMine }) {
  const ids = ["mine", "group"];
  const refs = useRef({});
  const onKey = (e) => {
    const i = ids.indexOf(tab);
    let next = null;
    if (e.key === "ArrowRight") next = ids[(i + 1) % ids.length];
    if (e.key === "ArrowLeft") next = ids[(i - 1 + ids.length) % ids.length];
    if (e.key === "Home") next = ids[0];
    if (e.key === "End") next = ids[ids.length - 1];
    if (next) {
      e.preventDefault();
      setTab(next);
      refs.current[next]?.focus();
    }
  };
  const label = { mine: hasMine ? "Edit my response" : "My availability", group: "Group overlap" };
  return (
    <div role="tablist" aria-label="Event views" className="flex gap-1 rounded-xl border border-gray-300 bg-white p-1 shadow-sm" onKeyDown={onKey}>
      {ids.map((id) => (
        <button
          key={id}
          ref={(el) => (refs.current[id] = el)}
          id={`tab-${id}`}
          role="tab"
          type="button"
          aria-selected={tab === id}
          aria-controls={`panel-${id}`}
          tabIndex={tab === id ? 0 : -1}
          onClick={() => setTab(id)}
          className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium ${FOCUS} ${tab === id ? "bg-indigo-700 text-white" : "text-gray-900 hover:bg-gray-100"}`}
        >
          {label[id]}
        </button>
      ))}
    </div>
  );
}

/* ---------- Entry grid (keyboard + pointer/touch) ---------- */
function AvailabilityEntry({
  event, dates, slots, gran, viewTz, tzDiffers, selectedDate, setSelectedDate,
  mySel, setMySel, applyKey, locked, myName, setMyName, nameRef,
}) {
  const dragRef = useRef(null);
  const pointerKeyRef = useRef(null);
  const btnRefs = useRef([]);

  useEffect(() => {
    const end = () => {
      dragRef.current = null;
      // The click (if any) fires right after pointerup; clear the marker after it.
      setTimeout(() => {
        pointerKeyRef.current = null;
      }, 0);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  const countForDate = (d) => {
    const prefix = `${d}|`;
    let n = 0;
    for (const k of mySel) if (k.startsWith(prefix)) n += 1;
    return n;
  };

  const setDay = (on) => {
    setMySel((prev) => {
      const n = new Set(prev);
      for (const s of slots) {
        const k = slotKey(selectedDate, s.start);
        if (on) n.add(k);
        else n.delete(k);
      }
      return n;
    });
  };

  const onKeyDown = (e, idx, key) => {
    let target = null;
    if (e.key === "ArrowDown") target = Math.min(slots.length - 1, idx + 1);
    if (e.key === "ArrowUp") target = Math.max(0, idx - 1);
    if (e.key === "Home") target = 0;
    if (e.key === "End") target = slots.length - 1;
    if (target === null || target === idx) return;
    e.preventDefault();
    if (e.shiftKey && !locked) {
      // Shift+Arrow extends: give the next slot the current slot's state
      applyKey(slotKey(selectedDate, slots[target].start), mySel.has(key));
    }
    btnRefs.current[target]?.focus();
  };

  return (
    <div className="space-y-4">
      <div className="max-w-sm">
        <label htmlFor="my-name" className={LABEL}>Your name <span aria-hidden="true">*</span></label>
        <input
          id="my-name"
          ref={nameRef}
          className={INPUT}
          value={myName}
          maxLength={80}
          autoComplete="name"
          required
          aria-required="true"
          disabled={locked}
          onChange={(e) => setMyName(e.target.value)}
        />
      </div>

      <div>
        <h3 id="date-strip-h" className={LABEL}>Date</h3>
        <div className="flex gap-2 overflow-x-auto pb-2 pt-2 pr-2" role="group" aria-labelledby="date-strip-h">
          {dates.map((d) => {
            const n = countForDate(d);
            const dt = DateTime.fromISO(d);
            const on = d === selectedDate;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                aria-label={`${fmtDateLong(d)}, ${n} slot${n === 1 ? "" : "s"} selected`}
                onClick={() => setSelectedDate(d)}
                className={`relative flex min-w-[4.25rem] flex-col items-center rounded-lg border px-2 py-2 text-sm ${FOCUS} ${
                  on ? "border-indigo-700 bg-indigo-700 text-white" : "border-gray-400 bg-white text-gray-900 hover:bg-gray-100"
                }`}
              >
                <span className="text-xs">{dt.toFormat("ccc")}</span>
                <span className="text-lg font-semibold leading-tight">{dt.day}</span>
                <span className="text-xs">{dt.toFormat("LLL")}</span>
                {n > 0 && (
                  <span aria-hidden="true" className={`absolute -right-1.5 -top-1.5 rounded-full px-1.5 text-xs font-semibold ${on ? "border-2 border-indigo-700 bg-white text-indigo-800" : "bg-indigo-700 text-white"}`}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 id="slot-h" className="text-sm font-medium text-gray-900">
            {selectedDate && fmtDateLong(selectedDate)} — times in {event.tz.replace(/_/g, " ")}
          </h3>
          <div className="flex gap-2">
            <button type="button" className={`${BTN_SECONDARY} py-1`} onClick={() => setDay(true)} disabled={locked}>Select all</button>
            <button type="button" className={`${BTN_SECONDARY} py-1`} onClick={() => setDay(false)} disabled={locked}>Clear day</button>
          </div>
        </div>
        <p id="slot-help" className="mb-2 text-xs text-gray-700">
          Click or press Enter/Space to toggle. Drag (mouse or touch) to paint several. Arrow keys move; Shift+Arrow extends.
        </p>
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-labelledby="slot-h" aria-describedby="slot-help">
          {slots.map((s, idx) => {
            const key = slotKey(selectedDate, s.start);
            const on = mySel.has(key);
            const v = tzDiffers ? viewerLabel(selectedDate, s, gran, event.tz, viewTz) : null;
            const label = slotLabel(s, gran);
            return (
              <button
                key={key}
                ref={(el) => (btnRefs.current[idx] = el)}
                type="button"
                data-key={key}
                disabled={locked}
                aria-pressed={on}
                aria-label={`${label}${v ? `, ${v.text} your time${v.shift ? `, ${v.shift}` : ""}` : ""}`}
                style={{ touchAction: "none" }}
                onPointerDown={(e) => {
                  if (locked || (e.pointerType === "mouse" && e.button !== 0)) return;
                  const mode = !on;
                  dragRef.current = { mode };
                  pointerKeyRef.current = key; // the follow-up click must not toggle again
                  applyKey(key, mode);
                  // Release implicit (touch) capture so pointerenter fires on siblings.
                  if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onPointerEnter={() => {
                  if (dragRef.current && !locked) applyKey(key, dragRef.current.mode);
                }}
                onClick={() => {
                  // Pointer presses were already applied on pointerdown. Any other
                  // activation (keyboard, screen-reader virtual click, switch access)
                  // toggles here.
                  if (pointerKeyRef.current === key) {
                    pointerKeyRef.current = null;
                    return;
                  }
                  pointerKeyRef.current = null;
                  if (!locked) applyKey(key, !on);
                }}
                onKeyDown={(e) => onKeyDown(e, idx, key)}
                className={`flex select-none items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${FOCUS} ${
                  on ? "border-indigo-800 bg-indigo-700 text-white" : "border-gray-400 bg-white text-gray-900 hover:bg-indigo-50"
                } ${locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
              >
                <span>
                  <span className="block font-medium">{label}</span>
                  {v && (
                    <span className={`block text-xs ${on ? "text-indigo-100" : "text-gray-700"}`}>
                      {v.text} your time{v.shift ? ` (${v.shift})` : ""}
                    </span>
                  )}
                </span>
                {on && <Check className="h-4 w-4 flex-none" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------- Heatmap (table semantics + roving tabindex) ---------- */
function heatClass(count, total) {
  if (!count || !total) return "bg-white text-gray-700";
  const r = count / total;
  if (r <= 0.25) return "bg-emerald-100 text-emerald-950";
  if (r <= 0.5) return "bg-emerald-200 text-emerald-950";
  if (r <= 0.75) return "bg-emerald-400 text-emerald-950";
  return "bg-emerald-700 text-white";
}

function Heatmap({
  event, dates, slots, gran, agg, total, viewTz, tzDiffers, rowViewerLabel, canSeeNames,
  finalized, finalizeMode, finalDraft, setFinalDraft, setActiveCell,
}) {
  const [pos, setPos] = useState({ r: 0, c: 0 });
  const refs = useRef({});

  const focusCell = (r, c) => {
    const rr = Math.max(0, Math.min(slots.length - 1, r));
    const cc = Math.max(0, Math.min(dates.length - 1, c));
    setPos({ r: rr, c: cc });
    refs.current[`${rr}-${cc}`]?.focus();
  };

  const onKeyDown = (e, r, c) => {
    const map = {
      ArrowDown: [r + 1, c], ArrowUp: [r - 1, c], ArrowRight: [r, c + 1], ArrowLeft: [r, c - 1],
      Home: [r, 0], End: [r, dates.length - 1],
      PageUp: [0, c], PageDown: [slots.length - 1, c],
    };
    if (map[e.key]) {
      e.preventDefault();
      focusCell(...map[e.key]);
    }
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-300">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Group availability. Rows are times in {event.tz}; columns are dates. Use arrow keys to move between cells.
          {finalizeMode ? " Press Enter or Space to mark a cell as a confirmed time." : ""}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 bg-gray-100 px-2 py-2 text-left text-xs font-semibold text-gray-900">
              Time ({tzAbbrev(event.tz, dates[0])})
            </th>
            {dates.map((d) => (
              <th key={d} scope="col" className="whitespace-nowrap bg-gray-100 px-1 py-2 text-center text-xs font-semibold text-gray-900">
                <abbr title={fmtDateLong(d)} className="no-underline">
                  {DateTime.fromISO(d).toFormat("ccc")}
                  <br />
                  {DateTime.fromISO(d).toFormat("LLL d")}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slots.map((s, r) => {
            const yourRow = rowViewerLabel(s);
            return (
              <tr key={s.start} className="border-t border-gray-200">
                <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-white px-2 py-1 text-left text-xs font-medium text-gray-900">
                  {slotLabel(s, gran)}
                  {yourRow && <span className="block text-[11px] font-normal text-gray-700">{yourRow} your time</span>}
                </th>
                {dates.map((d, c) => {
                  const key = slotKey(d, s.start);
                  const a = agg.get(key) || { count: 0, names: [] };
                  const isFinal = finalized.has(key);
                  const inDraft = finalDraft.has(key);
                  const v = tzDiffers ? viewerLabel(d, s, gran, event.tz, viewTz) : null;
                  const names = canSeeNames && a.names.length ? `. Available: ${a.names.join(", ")}` : "";
                  const label =
                    `${fmtDateLong(d)}, ${slotLabel(s, gran)} event time` +
                    (v ? `, ${v.localDate} ${v.text} your time` : "") +
                    `: ${a.count} of ${total} available${names}` +
                    (isFinal ? ". Confirmed time" : "");
                  const markStar = finalizeMode ? inDraft : isFinal;
                  return (
                    <td key={d} className="p-0.5">
                      <button
                        ref={(el) => (refs.current[`${r}-${c}`] = el)}
                        type="button"
                        tabIndex={pos.r === r && pos.c === c ? 0 : -1}
                        aria-label={label}
                        aria-pressed={finalizeMode ? inDraft : undefined}
                        onFocus={() => {
                          setPos({ r, c });
                          setActiveCell({ date: d, slot: s });
                        }}
                        onMouseEnter={() => setActiveCell({ date: d, slot: s })}
                        onClick={() => {
                          setActiveCell({ date: d, slot: s });
                          if (!finalizeMode) return;
                          setFinalDraft((prev) => {
                            const n = new Set(prev);
                            if (n.has(key)) n.delete(key);
                            else n.add(key);
                            return n;
                          });
                        }}
                        onKeyDown={(e) => onKeyDown(e, r, c)}
                        className={`relative flex h-9 w-full min-w-[3rem] items-center justify-center rounded text-xs font-semibold ${FOCUS} ${heatClass(a.count, total)} ${
                          markStar ? "ring-2 ring-amber-500 ring-offset-1" : "border border-gray-200"
                        } ${finalizeMode ? "cursor-pointer" : "cursor-default"}`}
                      >
                        {a.count > 0 ? a.count : <span className="text-gray-400" aria-hidden="true">·</span>}
                        {markStar && <Star className="absolute right-0.5 top-0.5 h-3 w-3 fill-amber-400 text-amber-700" aria-hidden="true" />}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Cell details panel (hover/focus "tooltip") ---------- */
function CellDetails({ activeCell, agg, total, gran, event, viewTz, tzDiffers, canSeeNames }) {
  if (!activeCell) {
    return <p className="mt-3 text-sm text-gray-700">Hover over or focus a cell to see who is available.</p>;
  }
  const { date, slot } = activeCell;
  const a = agg.get(slotKey(date, slot.start)) || { count: 0, names: [] };
  const v = tzDiffers ? viewerLabel(date, slot, gran, event.tz, viewTz) : null;
  return (
    <div className="mt-3 rounded-lg border border-gray-300 bg-gray-50 p-3 text-sm text-gray-900" aria-hidden="true">
      <p className="font-medium">
        {fmtDateLong(date)} · {slotLabel(slot, gran)} {tzAbbrev(event.tz, date)}
      </p>
      {v && (
        <p className="text-gray-700">
          Your time: {v.localDate}, {v.text} {tzAbbrev(viewTz, date)}
          {v.shift && <strong> ({v.shift})</strong>}
        </p>
      )}
      <p className="mt-1">
        <Users className="mr-1 inline h-4 w-4" aria-hidden="true" />
        {a.count} of {total} available
      </p>
      {canSeeNames && a.names.length > 0 && <p className="mt-1 text-gray-800">{a.names.join(", ")}</p>}
    </div>
  );
}

/* ---------- Edit modal ---------- */
function EditModal({ event, onClose, onSave, toast }) {
  const [cfg, setCfg] = useState(() => configFromRow(event));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const ok = await onSave(cfg);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title="Edit event"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} onClick={save} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />} Save changes
          </button>
        </>
      }
    >
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-700 bg-amber-50 p-3 text-sm text-amber-950">
        <Info className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
        <p>
          The code stays the same. If you shrink the dates, hours, or change the slot size, responses outside the new grid
          stop being shown and confirmed times outside it are removed.
        </p>
      </div>
      <ConfigForm cfg={cfg} setCfg={setCfg} idPrefix="edit" onToast={toast} />
    </Modal>
  );
}

/* ---------- Export modal (column picker) ---------- */
function ExportModal({ isOrganizer, tzDiffers, onClose, onExport }) {
  const [cols, setCols] = useState({ date: true, time: true, yourTime: tzDiffers, free: true, total: true, names: false });
  const options = [
    ["date", "Date"],
    ["time", "Time (event zone)"],
    ["yourTime", "Time (your zone)"],
    ["free", "People free"],
    ["total", "Total responders"],
    ...(isOrganizer ? [["names", "Names"]] : []),
  ];
  const any = Object.entries(cols).some(([k, v]) => v && (k !== "names" || isOrganizer));
  return (
    <Modal
      title="Export CSV"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={!any}
            onClick={() => {
              onExport(cols);
              onClose();
            }}
          >
            <Download className="h-4 w-4" aria-hidden="true" /> Download
          </button>
        </>
      }
    >
      <fieldset>
        <legend className={LABEL}>Columns to include</legend>
        <div className="space-y-2">
          {options.map(([k, label]) => (
            <div key={k} className="flex items-center gap-2">
              <input
                id={`col-${k}`}
                type="checkbox"
                className={`h-4 w-4 rounded border-gray-600 text-indigo-700 ${FOCUS}`}
                checked={!!cols[k]}
                onChange={(e) => setCols((c) => ({ ...c, [k]: e.target.checked }))}
              />
              <label htmlFor={`col-${k}`} className="text-sm text-gray-900">{label}</label>
            </div>
          ))}
        </div>
      </fieldset>
      {!isOrganizer && (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-gray-400 bg-gray-50 p-3 text-sm text-gray-900">
          <EyeOff className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
          Exports are anonymized. Only the organizer can export respondent names.
        </p>
      )}
      {isOrganizer && cols.names && (
        <p className="mt-4 text-sm text-amber-900">
          Names can be personally identifiable information. Store and share this file accordingly.
        </p>
      )}
    </Modal>
  );
}

/* =====================================================================
 * Root
 * ===================================================================== */
export default function AvailabilityApp() {
  const [userId, setUserId] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [code, setCode] = useState(() => {
    const c = new URLSearchParams(window.location.search).get("e");
    return c && /^[A-Z0-9]{6}$/i.test(c) ? c.toUpperCase() : null;
  });
  const [toastState, setToastState] = useState(null);

  const toast = useCallback((msg, tone = "info") => setToastState({ msg, tone, id: Date.now() }), []);
  useEffect(() => {
    if (!toastState) return undefined;
    const t = setTimeout(() => setToastState(null), 5000);
    return () => clearTimeout(t);
  }, [toastState]);

  // Anonymous auth: every browser gets a real auth.uid() without sign-up.
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        if (alive) setUserId(session.user.id);
        return;
      }
      const { data, error } = await supabase.auth.signInAnonymously();
      if (!alive) return;
      if (error) setAuthError(error.message);
      else setUserId(data.user.id);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Keep ?e=CODE in the URL so the page can be shared/bookmarked.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (code) url.searchParams.set("e", code);
    else url.searchParams.delete("e");
    window.history.replaceState(null, "", url);
  }, [code]);

  const leave = useCallback(
    (msg) => {
      setCode(null);
      if (msg) toast(msg, "error");
    },
    [toast],
  );

  const createEvent = async (cfg) => {
    const row = rowFromConfig(cfg);
    for (let i = 0; i < 5; i += 1) {
      const c = genCode();
      const { error } = await supabase.from("events").insert({ ...row, code: c, owner_id: userId });
      if (!error) {
        setCode(c);
        toast(`Event created. Share code ${c} with your group.`, "success");
        return true;
      }
      if (error.code !== "23505") {
        toast(`Couldn't create event: ${error.message}`, "error");
        return false;
      }
    }
    toast("Couldn't generate a unique code. Please try again.", "error");
    return false;
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-300 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-4">
          <Calendar className="h-6 w-6 text-indigo-700" aria-hidden="true" />
          <h1 className="text-xl font-semibold">Availability Scheduler</h1>
        </div>
      </header>
      <main id="main" className="px-4 py-6">
        {authError ? (
          <div role="alert" className="mx-auto max-w-xl rounded-xl border border-red-700 bg-red-50 p-5 text-red-900">
            <p className="font-semibold">Couldn't start a session.</p>
            <p className="mt-1 text-sm">{authError}</p>
            <p className="mt-2 text-sm">Check that anonymous sign-ins are enabled in Supabase Auth.</p>
          </div>
        ) : !userId ? (
          <div className="mx-auto max-w-xl text-center"><Spinner label="Starting session" /></div>
        ) : code ? (
          <EventView key={code} code={code} userId={userId} onLeave={leave} toast={toast} />
        ) : (
          <Home onCreate={createEvent} onJoin={setCode} toast={toast} />
        )}
      </main>
      <Toast toast={toastState} />
    </div>
  );
}
