"use client";

import React, { useEffect, useState, useRef } from "react";
import { Bell, AlertTriangle, AlertCircle, CheckCircle2, Mail, ExternalLink, X, RefreshCw } from "lucide-react";
import Link from "next/link";
import clsx from "clsx";
import type { AlertRecord, HealthAssessment } from "@/lib/notifications/types";
import { formatPaise } from "@/lib/format";

export function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [health, setHealth] = useState<HealthAssessment | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  /**
   * Bumped to refetch.
   *
   * The fetch lives inside the effect so none of its setState calls run
   * synchronously in an effect body; this is how the bell and the refresh
   * button ask for a new one without pulling the function back out.
   */
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    // Declared inside the effect and guarded by `cancelled`.
    //
    // As a component-scope function it was called synchronously from the effect
    // and its first statement was `setLoading(true)` — a setState inside an
    // effect body, which schedules an immediate second render before the first
    // has painted. It also left a live interval able to setState after unmount.
    //
    // Every setState below now happens after an await, and none of them runs
    // once the component is gone.
    let cancelled = false;

    const fetchNotifications = async () => {
      try {
        const res = await fetch("/api/notifications");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setAlerts(data.recentAlerts || []);
        setHealth(data.currentHealth || null);
      } catch {
        // Non-fatal: this is a background poll, and a failed refresh should
        // leave the last good list on screen rather than clearing it.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchNotifications();
    const interval = setInterval(fetchNotifications, 60000); // refresh every minute
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [reloadKey]);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const hasCritical = health?.severity === "CRITICAL";
  const hasWarning = health?.severity === "WARNING";
  const unreadCount = alerts.filter((a) => a.deliveryStatus === "SENT" || a.deliveryStatus === "SIMULATED").length;

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Button */}
      <button
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) refresh();
        }}
        className={clsx(
          "relative p-2 rounded-lg transition-colors border",
          hasCritical
            ? "border-rose-500/40 text-rose-400 bg-rose-500/10 hover:bg-rose-500/20"
            : hasWarning
            ? "border-amber-500/40 text-amber-400 bg-amber-500/10 hover:bg-amber-500/20"
            : "border-ground-300 text-ink-300 hover:text-ink-100 hover:bg-ground-200"
        )}
        title="Financial Health Alerts & Notifications"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {(hasCritical || unreadCount > 0) && (
          <span
            className={clsx(
              "absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ring-2 ring-ground-100 animate-pulse",
              hasCritical ? "bg-rose-500" : "bg-amber-500"
            )}
          />
        )}
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-xl border border-ground-300 bg-ground-100 shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
          
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-ground-300 bg-ground-200/50">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-ink-300" />
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-200">
                Health &amp; Alert Notifications
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={refresh}
                disabled={loading}
                className="p-1 text-ink-400 hover:text-ink-200 rounded transition-colors"
                title="Refresh"
              >
                <RefreshCw className={clsx("w-3.5 h-3.5", loading && "animate-spin")} />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 text-ink-400 hover:text-ink-200 rounded transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Current Live Health Status Banner */}
          {health && (
            <div
              className={clsx(
                "p-3.5 border-b flex items-start gap-3",
                health.severity === "CRITICAL"
                  ? "bg-rose-950/40 border-rose-900/40 text-rose-200"
                  : health.severity === "WARNING"
                  ? "bg-amber-950/40 border-amber-900/40 text-amber-200"
                  : "bg-emerald-950/30 border-emerald-900/30 text-emerald-200"
              )}
            >
              {health.severity === "CRITICAL" ? (
                <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
              ) : health.severity === "WARNING" ? (
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              )}
              <div className="text-xs space-y-1">
                <div className="font-semibold text-sm text-ink-100 flex items-center justify-between">
                  <span>
                    {health.severity === "CRITICAL"
                      ? "🚨 Critical Cash Deficit"
                      : health.severity === "WARNING"
                      ? "⚠️ Buffer Warning"
                      : "✅ Runway Healthy"}
                  </span>
                  <span className="text-xs font-mono font-normal">
                    {health.runwayDays}d runway
                  </span>
                </div>
                <div className="text-ink-300">
                  Cash: <strong>{formatPaise(health.currentBalance)}</strong> | Safety Buffer:{" "}
                  {formatPaise(health.safetyBuffer)}
                </div>
                {health.projectedDeficitDate && (
                  <div className="text-rose-300">
                    Deficit projected on {new Date(health.projectedDeficitDate).toLocaleDateString("en-IN")}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Alert History List */}
          <div className="max-h-72 overflow-y-auto divide-y divide-ground-300">
            {alerts.length === 0 ? (
              <div className="p-6 text-center text-xs text-ink-400">
                No recent alert emails dispatched.
              </div>
            ) : (
              alerts.slice(0, 8).map((alert) => {
                const wasSent =
                  alert.deliveryStatus === "SENT" ||
                  alert.deliveryStatus === "SIMULATED" ||
                  alert.deliveryStatus === "ACCEPTED";

                return (
                  <div key={alert.alertId} className="p-3 text-xs space-y-1.5 hover:bg-ground-200/40 transition-colors">
                    <div className="flex items-center justify-between">
                      <span
                        className={clsx(
                          "px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                          alert.severity === "CRITICAL"
                            ? "bg-rose-500/20 text-rose-400"
                            : "bg-amber-500/20 text-amber-400"
                        )}
                      >
                        {alert.severity}
                      </span>
                      <span className="text-[11px] text-ink-400">
                        {new Date(alert.detectedAt).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>

                    <div className="text-ink-100 font-medium line-clamp-1">
                      {alert.crisisTitle || alert.crisisKey}
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-ink-400">
                      {wasSent ? (
                        <span className="flex items-center gap-1 text-emerald-400 font-medium">
                          <Mail className="w-3 h-3" />
                          Email Dispatched {alert.deliveryStatus === "SIMULATED" && "(Sandbox)"}
                        </span>
                      ) : (
                        <span className="text-ink-400 italic">
                          Suppressed: {alert.suppressionReason || "User online"}
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-ink-500">
                        {alert.userEmail.split("@")[0]}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          <div className="p-2.5 bg-ground-200/60 border-t border-ground-300 flex items-center justify-between text-xs">
            <Link
              href="/profile"
              onClick={() => setIsOpen(false)}
              className="text-brand-400 hover:text-brand-300 font-medium inline-flex items-center gap-1"
            >
              Alert Settings &amp; Preferences <ExternalLink className="w-3 h-3" />
            </Link>
            <Link
              href="/approval"
              onClick={() => setIsOpen(false)}
              className="text-ink-200 hover:text-ink-100"
            >
              View Actions &rarr;
            </Link>
          </div>

        </div>
      )}
    </div>
  );
}
