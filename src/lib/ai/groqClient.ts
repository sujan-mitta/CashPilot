import Groq from "groq-sdk";

export const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || "gsk_placeholder",
});

export const MODEL = "qwen/qwen3.6-27b";
