"use client";

import React, { useState, useEffect } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { Mail, Bell, Shield, Eye, Check, RefreshCw } from "lucide-react";
import type { NotificationPreferences as PrefsType } from "@/lib/notifications/types";

export function NotificationPreferences() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prefs, setPrefs] = useState<PrefsType>({
    criticalAlertsEnabled: true,
    warningAlertsEnabled: true,
    weeklyDigestEnabled: true,
    criticalCooldownHours: 72,
    warningCooldownHours: 168,
    offlineThresholdMinutes: 30,
  });

  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewSubject, setPreviewSubject] = useState<string>("");
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    fetchPrefs();
  }, []);

  const fetchPrefs = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/notifications");
      if (res.ok) {
        const data = await res.json();
        if (data.preferences) setPrefs(data.preferences);
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.preferences) setPrefs(data.preferences);
        toast({
          tone: "success",
          title: "Preferences Saved",
          description: "Your alert notification frequencies and cooldowns have been updated.",
        });
      } else {
        throw new Error("Failed to update preferences");
      }
    } catch (err) {
      toast({
        tone: "danger",
        title: "Error Saving Preferences",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleOpenPreview = async () => {
    try {
      setPreviewLoading(true);
      setShowPreviewModal(true);
      const res = await fetch("/api/notifications/preview");
      if (res.ok) {
        const data = await res.json();
        setPreviewHtml(data.html || "");
        setPreviewSubject(data.subject || "CashPilot Alert Preview");
      }
    } catch {
      toast({
        tone: "danger",
        title: "Preview Generation Failed",
        description: "Unable to render email preview.",
      });
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <Card className="p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-ground-300 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 text-brand-300 flex items-center justify-center">
            <Mail className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-ink-100 flex items-center gap-2">
              Email Alerts &amp; Anti-Spam Notification Engine
              <Badge tone="brand">Intelligent</Badge>
            </h2>
            <p className="text-xs text-ink-300">
              Proactive alerts with offline detection, dashboard-awareness, and automated cooldowns.
            </p>
          </div>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={handleOpenPreview}
          className="self-start sm:self-auto"
        >
          <Eye className="w-4 h-4 mr-1.5" />
          Preview Alert Email
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Toggle Controls */}
        <div className="space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-ink-200">
            Alert Channels &amp; Severity
          </h3>

          <label className="flex items-start gap-3 p-3 rounded-lg border border-ground-300 bg-ground-200/30 cursor-pointer hover:bg-ground-200/50 transition-colors">
            <input
              type="checkbox"
              checked={prefs.criticalAlertsEnabled}
              onChange={(e) => setPrefs({ ...prefs, criticalAlertsEnabled: e.target.checked })}
              className="mt-0.5 rounded border-ground-400 text-brand-500 focus:ring-brand-400"
            />
            <div className="text-xs space-y-0.5">
              <div className="font-semibold text-ink-100 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-rose-500" />
                🚨 Critical Cash Runway Alerts
              </div>
              <p className="text-ink-300">
                Dispatches immediately when runway &lt; 14 days or a deficit is projected, but <strong>only if you are offline (&gt;30m inactive)</strong>.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 p-3 rounded-lg border border-ground-300 bg-ground-200/30 cursor-pointer hover:bg-ground-200/50 transition-colors">
            <input
              type="checkbox"
              checked={prefs.warningAlertsEnabled}
              onChange={(e) => setPrefs({ ...prefs, warningAlertsEnabled: e.target.checked })}
              className="mt-0.5 rounded border-ground-400 text-brand-500 focus:ring-brand-400"
            />
            <div className="text-xs space-y-0.5">
              <div className="font-semibold text-ink-100 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                ⚠️ Warning Health Alerts
              </div>
              <p className="text-ink-300">
                Alerts when balance falls below required safety buffer, only if inactive for &gt;24 hours.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 p-3 rounded-lg border border-ground-300 bg-ground-200/30 cursor-pointer hover:bg-ground-200/50 transition-colors">
            <input
              type="checkbox"
              checked={prefs.weeklyDigestEnabled}
              onChange={(e) => setPrefs({ ...prefs, weeklyDigestEnabled: e.target.checked })}
              className="mt-0.5 rounded border-ground-400 text-brand-500 focus:ring-brand-400"
            />
            <div className="text-xs space-y-0.5">
              <div className="font-semibold text-ink-100 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                📊 Weekly Monday Morning Briefing
              </div>
              <p className="text-ink-300">
                A clean summary of your runway, invoices, and obligations delivered every Monday at 8:00 AM.
              </p>
            </div>
          </label>
        </div>

        {/* Anti-Spam Cooldown Configuration */}
        <div className="space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-ink-200 flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-brand-400" />
            Anti-Spam &amp; Cooldown Guardrails
          </h3>

          <div className="space-y-3 bg-ground-200/40 p-4 rounded-xl border border-ground-300 text-xs">
            <div>
              <label className="font-medium text-ink-100 block mb-1">
                Critical Alert Cooldown (Hours)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={24}
                  max={168}
                  value={prefs.criticalCooldownHours}
                  onChange={(e) =>
                    setPrefs({ ...prefs, criticalCooldownHours: Number(e.target.value) })
                  }
                  className="w-24 px-2.5 py-1.5 rounded-lg bg-ground-100 border border-ground-300 text-ink-100 font-mono text-xs focus:ring-1 focus:ring-brand-400"
                />
                <span className="text-ink-400">
                  (Default: 72h / 3 days per unique deficit date)
                </span>
              </div>
            </div>

            <div>
              <label className="font-medium text-ink-100 block mb-1">
                Warning Alert Cooldown (Hours)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={48}
                  max={336}
                  value={prefs.warningCooldownHours}
                  onChange={(e) =>
                    setPrefs({ ...prefs, warningCooldownHours: Number(e.target.value) })
                  }
                  className="w-24 px-2.5 py-1.5 rounded-lg bg-ground-100 border border-ground-300 text-ink-100 font-mono text-xs focus:ring-1 focus:ring-brand-400"
                />
                <span className="text-ink-400">
                  (Default: 168h / 7 days per safety buffer breach)
                </span>
              </div>
            </div>

            <div className="pt-2 border-t border-ground-300/60 text-[11px] text-ink-400 leading-relaxed">
              💡 <strong>Dashboard-Aware Suppression:</strong> If you are actively browsing the dashboard when a health change occurs, email dispatch is automatically suppressed because you have already seen the forecast on screen.
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <Button onClick={handleSave} disabled={saving} size="sm">
              {saving ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Saving...
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5 mr-1.5" /> Save Preferences
                </>
              )}
            </Button>
          </div>
        </div>

      </div>

      {/* Preview Modal */}
      {showPreviewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-2xl bg-ground-100 border border-ground-300 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-ground-300 bg-ground-200">
              <div>
                <h3 className="text-sm font-semibold text-ink-100">Live Email Template Preview</h3>
                <p className="text-xs text-ink-400 font-mono">{previewSubject}</p>
              </div>
              <button
                onClick={() => setShowPreviewModal(false)}
                className="p-1 text-ink-400 hover:text-ink-100 rounded-lg"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 bg-[#0a0a0a]">
              {previewLoading ? (
                <div className="py-20 text-center text-xs text-ink-400">
                  <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-brand-400" />
                  Rendering production email template...
                </div>
              ) : (
                <div
                  className="rounded-lg overflow-hidden border border-[#262626]"
                  dangerouslySetInnerHTML={{ __html: previewHtml || "" }}
                />
              )}
            </div>

            <div className="p-3 bg-ground-200 border-t border-ground-300 text-right">
              <Button size="sm" variant="secondary" onClick={() => setShowPreviewModal(false)}>
                Close Preview
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
