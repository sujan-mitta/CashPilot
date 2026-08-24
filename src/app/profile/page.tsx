"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useCashPilot } from "@/context/CashPilotContext";
import { initialsOf } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/Reveal";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Briefcase, Key, ArrowLeft, Shield, CheckCircle2, TrendingUp, Landmark } from "lucide-react";

interface Integration {
  label: string;
  sub: string;
  status: string;
  icon: React.ReactNode;
  iconBg: string;
}

const integrations: Integration[] = [
  {
    label: "Razorpay Gateway Connection",
    sub: "Test Mode active",
    status: "Connected",
    icon: <span className="text-[10px] font-black">RZP</span>,
    iconBg: "bg-brand-500/10 text-brand-300",
  },
  {
    label: "Groq AI Inference Service",
    sub: "Using qwen/qwen3.6-27b",
    status: "Connected",
    icon: <span className="text-[10px] font-black">GRQ</span>,
    iconBg: "bg-brand-500/10 text-brand-300",
  },
  {
    label: "SBI Corporate Banking Ledger",
    sub: "Mock Bank Node Link",
    status: "Synced",
    icon: <Landmark className="w-4 h-4" />,
    iconBg: "bg-ground-200 text-ink-300",
  },
];

interface BusinessField {
  label: string;
  value?: string;
  accessor?: "businessName";
  muted?: boolean;
}

const businessFields: BusinessField[] = [
  { label: "Company Registered Name", accessor: "businessName" },
  { label: "Base Currency", value: "INR (₹) Indian Rupee" },
  { label: "Tax Identification Number", value: "27AAAAA1111A1Z1 (Mock GSTIN)", muted: true },
  { label: "Operational Country", value: "India" },
];

export default function Profile() {
  const router = useRouter();
  const { user } = useCashPilot();

  const businessName = user?.businessName || "ABC Electronics Pvt Ltd";
  const name = user?.name || "Aryan Mittal";
  const email = user?.email || "mittal@company.com";
  const initials = initialsOf(name);

  return (
    <main className="flex-1 max-w-4xl mx-auto px-6 py-10 w-full space-y-10">
      {/* Header navigation bar */}
      <Reveal className="flex justify-between items-center flex-wrap gap-4">
        <div>
          <h1 className="text-xl font-black text-ink-100 tracking-tight">Account &amp; Settings</h1>
          <p className="text-ink-300 text-xs mt-1">
            Manage your business profile, integrations, and controller access.
          </p>
        </div>
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 px-4 py-2 bg-ground-100 border border-line-soft rounded-xl text-xs font-bold text-ink-200 hover:bg-ground-200 hover:border-line-firm transition-colors duration-150 shadow-sm outline-none"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Cash Command Dashboard
        </button>
      </Reveal>

      <Stagger className="space-y-8" stagger={0.09}>
        {/* Profile Card Header */}
        <StaggerItem>
          <Card hoverable className="flex flex-col sm:flex-row items-center gap-6">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-600 flex items-center justify-center text-2xl font-black text-white shadow-lg shadow-brand-500/30 flex-shrink-0">
              {initials || "CP"}
            </div>

            <div className="text-center sm:text-left flex-grow">
              <h2 className="text-2xl font-black text-ink-100 tracking-tight">{name}</h2>
              <p className="text-xs text-ink-400 font-bold uppercase tracking-wider mt-0.5">
                Financial Controller • {businessName}
              </p>
              <p className="text-xs text-ink-300 font-semibold mt-2">{email}</p>
            </div>

            <div className="flex sm:flex-col items-center sm:items-end gap-2 border-t sm:border-t-0 sm:border-l border-line-faint pt-4 sm:pt-0 sm:pl-6 w-full sm:w-auto justify-center sm:justify-start">
              <Badge tone="brand" size="sm">
                <Shield className="w-3.5 h-3.5 mr-1.5" />
                Verified Controller
              </Badge>
            </div>
          </Card>
        </StaggerItem>

        {/* Profile Details Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Business & Controller config */}
          <div className="md:col-span-2 space-y-6">
            <StaggerItem>
              <Card className="space-y-4">
                <h3 className="text-sm font-black text-ink-100 uppercase tracking-wider border-b border-line-faint pb-3 flex items-center gap-2">
                  <Briefcase className="w-4 h-4 text-ink-400" />
                  Business Profile
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  {businessFields.map((field) => (
                    <div key={field.label}>
                      <span className="text-ink-400 font-bold uppercase block mb-1">{field.label}</span>
                      <span className={field.muted ? "text-ink-300 font-bold" : "text-ink-200 font-bold"}>
                        {field.accessor === "businessName" ? businessName : field.value}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </StaggerItem>

            <StaggerItem>
              <Card className="space-y-4">
                <h3 className="text-sm font-black text-ink-100 uppercase tracking-wider border-b border-line-faint pb-3 flex items-center gap-2">
                  <Key className="w-4 h-4 text-ink-400" />
                  Integration Settings
                </h3>

                <div className="space-y-3">
                  {integrations.map((integ) => (
                    <div
                      key={integ.label}
                      className="card-hover flex items-center justify-between p-3 rounded-2xl bg-ground-200 border border-line-faint"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${integ.iconBg}`}>
                          {integ.icon}
                        </div>
                        <div>
                          <span className="text-xs font-bold text-ink-200 block">{integ.label}</span>
                          <span className="text-[10px] text-ink-400 font-semibold block">{integ.sub}</span>
                        </div>
                      </div>
                      <Badge tone="success">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        {integ.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              </Card>
            </StaggerItem>
          </div>

          {/* Stat Cards Side Panel */}
          <StaggerItem>
            <Card className="space-y-4 h-fit" tone="raised">
              <h3 className="text-sm font-black text-white uppercase tracking-wider border-b border-line-soft pb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-ink-400" />
                Intervention Stats
              </h3>

              <div className="space-y-4">
                <div className="p-3 bg-white/5 border border-white/10 rounded-2xl">
                  <span className="text-[9px] font-bold text-ink-400 uppercase tracking-widest block">
                    Forecast Runway Horizon
                  </span>
                  <span className="text-lg font-black text-white mt-1 block">
                    <AnimatedNumber value={14} format={(n) => `${Math.round(n)} Days`} />
                  </span>
                </div>

                <div className="p-3 bg-white/5 border border-white/10 rounded-2xl">
                  <span className="text-[9px] font-bold text-ink-400 uppercase tracking-widest block">
                    Deficits Identified &amp; Blocked
                  </span>
                  <span className="text-lg font-black text-risk-400 mt-1 block">
                    <AnimatedNumber value={420000} format={(n) => `₹${Math.round(n).toLocaleString("en-IN")}`} />
                  </span>
                </div>

                <div className="p-3 bg-white/5 border border-white/10 rounded-2xl">
                  <span className="text-[9px] font-bold text-ink-400 uppercase tracking-widest block">
                    Intervention Decision Accuracy
                  </span>
                  <span className="text-lg font-black text-safe-400 mt-1 block">
                    <AnimatedNumber value={98.4} format={(n) => `${n.toFixed(1)}%`} />
                  </span>
                </div>
              </div>
            </Card>
          </StaggerItem>
        </div>
      </Stagger>
    </main>
  );
}
