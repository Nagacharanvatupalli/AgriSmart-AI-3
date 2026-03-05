import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);

const LANG_NAME: Record<string, string> = {
  en: "English",
  te: "Telugu",
  hi: "Hindi",
  ta: "Tamil",
};

// ─── Visual Symptoms ──────────────────────────────────────────────────────────
export const getVisualSymptoms = async (base64Image: string, mimeType: string, language = "en") => {
  const languageName = LANG_NAME[language] || "English";
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt =
    `Act as a specialized agricultural vision system. Analyze this crop image and provide a highly detailed, objective list of visual symptoms. Focus on: leaf color changes, spot patterns (size, color, margin), stem condition, insect presence, and growth anomalies. Do NOT provide a diagnosis or treatment plan. Just describe exactly what is visible in a structured list. Respond in ${languageName}.`;

  const imagePart = {
    inlineData: {
      data: base64Image,
      mimeType: mimeType as any,
    },
  };

  const result = await model.generateContent([prompt, imagePart]);
  return result.response.text();
};

// ─── In-memory cache ─────────────────────────────────────────────────────────
const adviceCache = new Map<string, { text: string; ts: number }>();
const CACHE_TTL = 1000 * 60 * 5; // 5 minutes



// ─── Agricultural Advice ──────────────────────────────────────────────────────
export const getAgriculturalAdvice = async (
  query: string,
  context?: string,
  language = "en"
) => {
  const languageName = LANG_NAME[language] || "English";
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: `You are an expert agricultural consultant. Give "gunshot" answers—short, direct, and actionable. EXTREME BREVITY IS REQUIRED. If the user asks for a price, return ONLY the price or a very short sentence. Respond in ${languageName}.`,
  });

  const cacheKey = `${language}::${query}`;
  const cached = adviceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.text;
  }

  const result = await model.generateContent(query);
  const text = result.response.text();

  adviceCache.set(cacheKey, { text, ts: Date.now() });
  return text;
};

// ─── Seasonal Insights ────────────────────────────────────────────────────────
export const getSeasonalInsights = async (location: string, month: string) => {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
    },
  });

  const prompt = `Provide agricultural insights for ${location} during the month of ${month}. Return a JSON object with exactly these keys: "recommendedCrops" (array of strings), "risks" (array of strings), "tasks" (array of strings), "summary" (string).`;

  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text() || "{}");
};