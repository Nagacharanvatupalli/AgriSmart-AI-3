import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);
const MODEL = "gemini-2.5-flash";

// ─── Step 1: Extract disease name + crop type from image ─────────────────────
export const identifyDiseaseFromImage = async (
    base64Image: string,
    mimeType: string
): Promise<{ disease: string; crop: string; symptoms: string }> => {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const prompt = `You are an expert agricultural plant pathologist. Analyze this crop image and respond in JSON format ONLY with these exact keys:
{
  "disease": "the specific disease or pest name (e.g. 'Late Blight', 'Leaf Rust', 'Powdery Mildew')",
  "crop": "the crop type (e.g. 'Tomato', 'Wheat', 'Rice')",
  "symptoms": "2-3 sentence description of visible symptoms"
}
If you cannot identify a specific disease, use "Unknown Disease" for disease. Respond only with raw JSON.`;

    const imagePart = { inlineData: { data: base64Image, mimeType: mimeType as any } };
    const result = await model.generateContent([prompt, imagePart]);
    const text = result.response.text().trim().replace(/```json|```/g, '');
    try {
        return JSON.parse(text);
    } catch {
        return { disease: "Unknown Disease", crop: "Unknown Crop", symptoms: text };
    }
};

// ─── Step 2: Query govt backend for official disease info ─────────────────────
async function fetchGovtDiseaseInfo(disease: string, crop: string) {
    try {
        const res = await fetch(
            `/api/crop-doctor/lookup?disease=${encodeURIComponent(disease)}&crop=${encodeURIComponent(crop)}`
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.found ? data : null;
    } catch {
        return null;
    }
}

// ─── Step 3 (Fallback): Full Gemini diagnosis ────────────────────────────────
export const getFullGeminiDiagnosis = async (
    base64Image: string,
    mimeType: string,
    disease: string,
    crop: string,
    symptoms: string
): Promise<string> => {
    const model = genAI.getGenerativeModel({
        model: MODEL,
        systemInstruction:
            "You are a senior agricultural plant pathologist with expertise in Indian crops. Provide detailed, actionable disease management advice.",
    });

    const prompt = `Based on the image analysis showing "${disease}" on a ${crop} plant with symptoms: "${symptoms}", provide a comprehensive diagnosis report covering:

1. **Disease Confirmation & Severity**
2. **Cause** (fungal/bacterial/viral/pest)
3. **Recommended Treatments** (organic + chemical options available in India)
4. **Preventive Measures**
5. **Expected Recovery Timeline**

Be specific and practical for Indian farmers.`;

    const imagePart = { inlineData: { data: base64Image, mimeType: mimeType as any } };
    const result = await model.generateContent([prompt, imagePart]);
    return result.response.text();
};

// ─── Main orchestrator ────────────────────────────────────────────────────────
export const diagnoseCrop = async (
    base64Image: string,
    mimeType: string
): Promise<string> => {
    // Step 1: Identify disease from image
    const { disease, crop, symptoms } = await identifyDiseaseFromImage(base64Image, mimeType);

    let report = `## 🌿 Crop Doctor Analysis\n\n`;
    report += `**Identified:** ${disease} on ${crop}\n`;
    report += `**Visual Symptoms:** ${symptoms}\n\n`;

    // Step 2: Try govt sources
    if (disease !== "Unknown Disease") {
        const govtData = await fetchGovtDiseaseInfo(disease, crop);
        if (govtData) {
            report += `---\n### 📋 Official Guidance *(${govtData.source})*\n\n`;
            if (govtData.symptoms) report += `**Symptoms:** ${govtData.symptoms}\n\n`;
            report += `**Control Measures:** ${govtData.control}\n\n`;
            report += `**Prevention:** ${govtData.prevention}\n\n`;
            if (govtData.pesticides) {
                report += `**Recommended Pesticides:** ${govtData.pesticides}\n\n`;
            }
            report += `> *Data sourced from ${govtData.source}*`;
            return report;
        }
    }

    // Step 3: Fallback to full Gemini diagnosis
    report += `---\n### 🤖 AI-Powered Full Diagnosis\n*(Government database lookup unavailable — using Gemini AI)*\n\n`;
    const geminiDiagnosis = await getFullGeminiDiagnosis(base64Image, mimeType, disease, crop, symptoms);
    report += geminiDiagnosis;
    return report;
};
