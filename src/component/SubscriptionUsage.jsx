/* global chrome */
/* eslint-disable react/prop-types */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import "./SubscriptionUsage.css";

function windowLabel(window, t) {
  const seconds = window.durationSeconds;
  if (!seconds) return t(window.id === "primary" ? "subscriptionUsageShortWindow" : "subscriptionUsageLongWindow");
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function severity(percent) {
  return percent >= 95 ? "danger" : percent >= 80 ? "warning" : "normal";
}

function relativeTime(timestamp, now, t, reset = false, locale) {
  if (!timestamp) return t(reset ? "subscriptionUsageUnknownReset" : "subscriptionUsageNotQueried");
  const minutes = Math.ceil(Math.abs(timestamp - now) / 60000);
  if (reset && timestamp <= now) return t("subscriptionUsageResetPending");
  const duration = minutes < 60
    ? t("subscriptionUsageMinutes", { count: Math.max(1, minutes) })
    : minutes < 1440
      ? t("subscriptionUsageHours", { count: Math.ceil(minutes / 60) })
      : t(Math.ceil(minutes / 1440) === 1 ? "subscriptionUsageDay" : "subscriptionUsageDays", { count: Math.ceil(minutes / 1440) });
  return reset
    ? t("subscriptionUsageResetsInAt", {
      duration,
      time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(timestamp)
    })
    : minutes <= 1 ? t("subscriptionUsageJustUpdated") : t("subscriptionUsageUpdatedAgo", { duration });
}

export default function SubscriptionUsage({ profile, compact = false }) {
  if (profile?.apiType !== "openai-subscription" || !profile.accountId) return null;
  return <UsageDisplay key={`${profile.accountId}:${profile.credentialId || profile.id}`} profile={profile} compact={compact} />;
}

function UsageDisplay({ profile, compact }) {
  const { locale, t } = useI18n();
  const translationRef = useRef(t);
  translationRef.current = t;
  const credentialId = profile.credentialId || profile.id;
  const [snapshot, setSnapshot] = useState({ data: null, updatedAt: null, error: "" });
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const rootRef = useRef(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const lastManual = useRef(0);
  const authorizationBlocked = useRef(false);
  const refresh = useCallback(async (options = {}) => {
    if (pending.current || document.visibilityState === "hidden") return;
    if (authorizationBlocked.current && !options.force) return;
    pending.current = true;
    setLoading(true);
    try {
      const response = await chrome.runtime.sendMessage({ type: "openai_subscription_usage", credentialId, ...options });
      if (!response?.success) throw new Error(response?.error || translationRef.current("subscriptionUsageQueryFailed"));
      authorizationBlocked.current = /重新登录/.test(response.result?.error || "");
      if (mounted.current) setSnapshot(response.result);
    } catch (error) {
      authorizationBlocked.current = /重新登录/.test(error.message);
      if (mounted.current) setSnapshot(current => ({ ...current, error: error.message }));
    } finally {
      pending.current = false;
      if (mounted.current) {
        setLoading(false);
        setNow(Date.now());
      }
    }
  }, [credentialId]);

  useEffect(() => {
    mounted.current = true;
    void refresh({ cacheOnly: true }).then(() => mounted.current && refresh());
    const onVisible = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const timer = setInterval(onVisible, 5 * 60000);
    const onLogin = message => {
      if (message?.type === "openai_subscription_oauth_completed" && message.success && message.profileId === credentialId) {
        authorizationBlocked.current = false;
        void refresh({ force: true });
      }
    };
    const clock = setInterval(() => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
    }, 10000);
    document.addEventListener("visibilitychange", onVisible);
    chrome.runtime.onMessage.addListener(onLogin);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
      chrome.runtime.onMessage.removeListener(onLogin);
    };
  }, [credentialId, refresh]);

  useEffect(() => {
    const resets = snapshot.data?.buckets.flatMap(bucket => bucket.windows.map(window => window.resetsAt)) || [];
    const nextReset = Math.min(...resets.filter(timestamp => timestamp > Date.now()));
    if (!Number.isFinite(nextReset)) return;
    const timer = setTimeout(() => void refresh({ force: true }), Math.min(2147483647, nextReset - Date.now() + 1000));
    return () => clearTimeout(timer);
  }, [snapshot.data, refresh]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeEscape = event => {
      if (event.key === "Escape") {
        setOpen(false);
        rootRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  const windows = snapshot.data?.buckets?.find(bucket => bucket.id === "codex")?.windows || [];
  const highest = Math.max(0, ...windows.map(window => window.usedPercent || 0));
  const summary = windows.map(window => `${windowLabel(window, t)} ${window.usedPercent === null ? "—" : `${window.usedPercent}%`}`).join(" · ");
  return <div className={`subscription-usage${compact ? " subscription-usage-compact" : ""}`} ref={rootRef}>
    {compact && <button type="button" className={`chat-input-model-button subscription-usage-trigger subscription-usage-${severity(highest)}`} aria-expanded={open} aria-label="Usage" title={summary ? t("subscriptionUsageUsed", { usage: summary }) : "Usage"} onClick={() => {
      setOpen(current => !current);
      if (!open) void refresh({ maxAge: 60000 });
    }}>
      <span className="subscription-usage-summary">{summary ? t("subscriptionUsageUsed", { usage: summary }) : "Usage"}</span>
      <span className="subscription-usage-short">Usage</span>
      {snapshot.error ? " !" : ""}
    </button>}
    {(!compact || open) && <section className="subscription-usage-card" aria-label={t("subscriptionUsageTitle")}>
      <div className="subscription-usage-heading"><strong>{t("subscriptionUsageTitle")}</strong><button type="button" disabled={loading || now - lastManual.current < 10000} onClick={() => {
        lastManual.current = Date.now();
        void refresh({ force: true });
      }}>{loading ? t("subscriptionUsageRefreshing") : t("subscriptionUsageRefresh")}</button></div>
      <div className="subscription-usage-meta">{snapshot.data?.planType || profile.planType || ""}</div>
      {!snapshot.data && <p>{loading ? t("subscriptionUsageLoading") : t("subscriptionUsageEmpty")}</p>}
      {snapshot.data?.buckets.map(bucket => <div key={bucket.id}>
        {bucket.id !== "codex" && <strong>{bucket.name}</strong>}
        {bucket.windows.length === 0 && <p>{t("subscriptionUsageWindowUnavailable")}</p>}
        {bucket.windows.map(window => <div key={window.id} className={`subscription-usage-window subscription-usage-${severity(window.usedPercent)}`}>
          <div className="subscription-usage-heading"><span>{t("subscriptionUsageWindow", { duration: windowLabel(window, t) })}</span><span>{t("subscriptionUsageUsedPercent", { percent: window.usedPercent === null ? "—" : `${window.usedPercent}%` })}</span></div>
          {window.usedPercent !== null && <progress max="100" value={Math.min(100, window.usedPercent)} aria-label={t("subscriptionUsageUsedPercent", { percent: `${windowLabel(window, t)} ${window.usedPercent}%` })} />}
          <div className="subscription-usage-meta" title={window.resetsAt ? new Date(window.resetsAt).toLocaleString(locale) : ""}>{relativeTime(window.resetsAt, now, t, true, locale)}</div>
        </div>)}
      </div>)}
      {snapshot.error && <p className="subscription-usage-error" role="status">{snapshot.error}; {t(snapshot.updatedAt ? "subscriptionUsageKeepStale" : "subscriptionUsageRetryLater")}</p>}
      <div className="subscription-usage-meta" title={snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleString(locale) : ""}>{relativeTime(snapshot.updatedAt, now, t)}</div>
      <div className="subscription-usage-meta">{t("subscriptionUsageAccount", { account: profile.email?.replace(/^(.).*(@.*)$/, "$1***$2") || t("subscriptionUsageSignedIn") })}</div>
    </section>}
  </div>;
}
