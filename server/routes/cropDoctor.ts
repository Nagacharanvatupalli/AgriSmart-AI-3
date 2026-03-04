import express from 'express';
import axios from 'axios';

const router = express.Router();

// ─── Structured result type ───────────────────────────────────────────────────
interface DiseaseInfo {
    source: string;
    disease: string;
    crop: string;
    symptoms?: string;
    control: string;
    prevention: string;
    pesticides?: string;
}

// ─── Helper: fetch from ICAR / Kisan Suvidha ─────────────────────────────────
async function fetchFromICAR(disease: string, crop: string): Promise<DiseaseInfo | null> {
    try {
        // ICAR PME (Pest Management Extension) search
        const url = `https://farmer.gov.in/CropProtectionMain.aspx`;
        // ICAR doesn't have a public JSON API - we use the AGMARKNET / NHB data
        // Instead, query the ICAR-NCIPM dataset via the open govt portal
        const govtUrl = `https://data.gov.in/api/datastore/resource.json?resource_id=ef2b5a19-ea08-4e5e-9e6b-36dcc5e78c52&filters[crop]=${encodeURIComponent(crop)}&limit=5`;
        const res = await axios.get(govtUrl, { timeout: 5000 });
        const records = res.data?.records || [];
        const match = records.find((r: any) =>
            r.disease?.toLowerCase().includes(disease.toLowerCase()) ||
            disease.toLowerCase().includes(r.disease?.toLowerCase())
        );
        if (match) {
            return {
                source: 'ICAR (data.gov.in)',
                disease: match.disease || disease,
                crop: match.crop || crop,
                symptoms: match.symptoms || '',
                control: match.control_measure || match.management || 'See official ICAR guidelines.',
                prevention: match.prevention || match.integrated_management || 'Practice crop rotation and field sanitation.',
                pesticides: match.pesticide_recommendation || '',
            };
        }
        return null;
    } catch {
        return null;
    }
}

// ─── Helper: fetch from NHB / Horticulture DB ────────────────────────────────
async function fetchFromNHB(disease: string, crop: string): Promise<DiseaseInfo | null> {
    try {
        // NHB Open Data - crop diseases resource
        const url = `https://data.gov.in/api/datastore/resource.json?resource_id=d4a0bce6-b80f-4e4f-b23e-e3f56c2c7b59&filters[crop_name]=${encodeURIComponent(crop)}&limit=5`;
        const res = await axios.get(url, { timeout: 5000 });
        const records = res.data?.records || [];
        const match = records.find((r: any) =>
            r.disease_name?.toLowerCase().includes(disease.toLowerCase()) ||
            disease.toLowerCase().includes(r.disease_name?.toLowerCase())
        );
        if (match) {
            return {
                source: 'NHB via data.gov.in',
                disease: match.disease_name || disease,
                crop: match.crop_name || crop,
                symptoms: match.symptoms || '',
                control: match.control || match.chemical_control || 'See NHB guidelines.',
                prevention: match.prevention || 'Use disease-resistant varieties.',
                pesticides: match.chemical_name || '',
            };
        }
        return null;
    } catch {
        return null;
    }
}

// ─── Helper: fallback generic search on data.gov.in ──────────────────────────
async function fetchFromDataGovIn(disease: string, crop: string): Promise<DiseaseInfo | null> {
    try {
        // Generic crop disease resource from data.gov.in
        const url = `https://data.gov.in/api/datastore/resource.json?resource_id=b8a6f8f0-5e1e-4f4d-8e8e-0e8e4f4d8e8e&q=${encodeURIComponent(disease + ' ' + crop)}&limit=3`;
        const res = await axios.get(url, { timeout: 5000 });
        const records = res.data?.records || [];
        if (records.length > 0) {
            const r = records[0];
            return {
                source: 'data.gov.in',
                disease: r.disease || disease,
                crop: r.crop || crop,
                control: r.control || r.management || 'Follow integrated pest management practices.',
                prevention: r.prevention || 'Maintain field hygiene and use resistant varieties.',
                pesticides: r.pesticide || '',
            };
        }
        return null;
    } catch {
        return null;
    }
}

// ─── Main lookup endpoint ─────────────────────────────────────────────────────
router.get('/lookup', async (req, res) => {
    const disease = String(req.query.disease || '').trim();
    const crop = String(req.query.crop || 'crop').trim();

    if (!disease) {
        return res.status(400).json({ error: 'disease query parameter required' });
    }

    console.log(`[CROP DOCTOR] Looking up: "${disease}" on crop: "${crop}"`);

    // Try sources in order
    let result: DiseaseInfo | null = null;

    result = await fetchFromICAR(disease, crop);
    if (result) {
        console.log('[CROP DOCTOR] Found in ICAR dataset');
        return res.json({ found: true, ...result });
    }

    result = await fetchFromNHB(disease, crop);
    if (result) {
        console.log('[CROP DOCTOR] Found in NHB dataset');
        return res.json({ found: true, ...result });
    }

    result = await fetchFromDataGovIn(disease, crop);
    if (result) {
        console.log('[CROP DOCTOR] Found in data.gov.in');
        return res.json({ found: true, ...result });
    }

    console.log('[CROP DOCTOR] No govt data found — client should use Gemini fallback');
    return res.json({ found: false, disease, crop });
});

export default router;
