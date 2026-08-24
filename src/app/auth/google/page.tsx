"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PilotIcon } from "@/components/PilotIcon";
import { EASE_OUT_EXPO } from "@/components/ui/motion";

const accounts = [
  { email: "mittal@company.com", name: "Aryan Mittal", initials: "AM", tone: "bg-indigo-50 text-indigo-700" },
  { email: "demo-guest@cashpilot.ai", name: "Demo Guest", initials: "DG", tone: "bg-slate-100 text-slate-600" },
];

export default function GoogleAuthMock() {
  const [selected, setSelected] = useState<string | null>(null);

  const handleSelect = (email: string, name: string) => {
    setSelected(email);

    // Simulate OAuth handshake validation
    setTimeout(() => {
      if (window.opener) {
        window.opener.postMessage(
          {
            type: "GOOGLE_AUTH_SUCCESS",
            user: {
              name,
              email,
              businessName: "ABC Electronics Pvt Ltd",
            },
          },
          "*"
        );
      }
      window.close();
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-[var(--background)] flex items-center justify-center p-4 font-sans">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: EASE_OUT_EXPO }}
        className="bg-white border border-slate-200 rounded-2xl w-full max-w-sm p-6 shadow-xl shadow-slate-200/70 space-y-6"
      >
        {/* Google Branding Header */}
        <div className="text-center space-y-2">
          {/* Custom Google colored logo representation */}
          <div className="flex justify-center mb-1">
            <svg className="w-8 h-8" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v3.9h6.69c-.29 1.5-.1.14-.1.14v2.54h1.03l2.42-1.87c2-1.86 3.7-4.64 3.7-8.64z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.97-1.08 7.96-2.91l-3.45-2.68c-.96.64-2.2 1.02-3.51 1.02-2.7 0-5-1.82-5.81-4.28H1.63v2.77C3.62 21.94 7.55 24 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M6.19 15.15A7.18 7.18 0 0 1 5.75 12c0-1.1.2-2.15.56-3.15V6.08H1.63A11.96 11.96 0 0 0 0 12c0 2.22.6 4.3 1.63 6.08l4.56-3.08z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.6 4.6 1.8l3.43-3.43C17.95 1.19 15.22 0 12 0 7.55 0 3.62 2.06 1.63 6.08l4.56 3.07C7 6.57 9.3 4.75 12 4.75z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-slate-800">Sign in with Google</h2>
          <p className="text-xs text-slate-500 font-semibold flex items-center justify-center gap-1.5">
            to continue to <PilotIcon className="w-3.5 h-3.5 text-indigo-600 inline" /> <span className="font-extrabold text-slate-700">CashPilot</span>
          </p>
        </div>

        {/* Account Selector options */}
        <div className="space-y-2 min-h-[6.5rem]">
          <AnimatePresence mode="wait">
            {selected ? (
              <motion.div
                key="authenticating"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center justify-center py-6 space-y-3"
              >
                <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-slate-500 font-bold">Authenticating session...</span>
              </motion.div>
            ) : (
              <motion.div key="accounts" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-2">
                {accounts.map((acc) => (
                  <button
                    key={acc.email}
                    onClick={() => handleSelect(acc.email, acc.name)}
                    className="w-full flex items-center justify-between p-3.5 hover:bg-slate-50 border border-slate-100 rounded-xl transition-colors duration-150 text-left outline-none"
                  >
                    <div>
                      <span className="text-xs font-bold text-slate-700 block">{acc.name}</span>
                      <span className="text-[10px] text-slate-400 font-semibold block">{acc.email}</span>
                    </div>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold ${acc.tone}`}>
                      {acc.initials}
                    </div>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="text-[10px] text-slate-400 font-semibold leading-relaxed text-center">
          To continue, Google will share your name, email address, language preference, and profile picture with CashPilot.
        </div>
      </motion.div>
    </div>
  );
}
