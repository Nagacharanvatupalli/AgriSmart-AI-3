import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import MarketPrice from '../models/MarketPrice';
import { authMiddleware } from '../middleware/authMiddleware';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const router = express.Router();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Official data.gov.in API for APMC market prices
const DATA_GOV_API_KEY = '579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b';
const DATA_GOV_RESOURCE_ID = '9ef84268-d588-465a-a308-a864a43d0070';

// Mapping local crop names to Agmarknet commodity names for better accuracy
const COMMODITY_MAP: { [key: string]: string } = {
    "Dry Chillies": "Chilli Red",
    "Chili Red": "Chilli Red",
    "Soybean": "Soyabean",
    "Paddy(Basmati)": "Paddy(Dhan)(Basmati)",
    "Paddy(Common)": "Paddy(Dhan)(Common)",
    "Corn": "Maize",
    "Ajwain Husk": "Ajwan",
    "Meal Maker (Soya Chunks)": "Soyabean",
    "Ginger(Dry)": "Ginger(Dry)",
    "Ginger(Green)": "Ginger(Green)",
    "Turmeric": "Turmeric",
    "Cotton": "Cotton",
    "Wheat": "Wheat",
    "Rice": "Rice",
    "Pulse": "Arhar (Tur/Red Gram)(Whole)"
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to check MongoDB for recently fetched data (today)
async function checkRecentCache(crop: string, market: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    try {
        const cached = await MarketPrice.find({
            commodity: crop,
            date: { $gte: today, $lte: endOfDay }
        }).sort({ is_primary: -1 });

        if (cached && cached.length > 0) {
            const hasPrimary = cached.some(m => m.market.toLowerCase() === market.toLowerCase());
            if (hasPrimary) return cached;
        }
    } catch (err) {
        console.log('[MARKET API] Cache check failed:', err);
    }
    return null;
}

// Fetch from official data.gov.in API with smart fallbacks (Market -> District -> State)
async function fetchFromDataGov(crop: string, searchLocation: string, retryCount = 0): Promise<any[] | null> {
    const searchCrop = COMMODITY_MAP[crop] || crop;

    const fetchWithFilter = async (filterKey: string, filterValue: string) => {
        try {
            const url = `https://api.data.gov.in/resource/${DATA_GOV_RESOURCE_ID}`;
            const response = await axios.get(url, {
                params: {
                    'api-key': DATA_GOV_API_KEY,
                    format: 'json',
                    limit: 50,
                    'filters[commodity]': searchCrop,
                    [`filters[${filterKey}]`]: filterValue
                },
                timeout: 15000
            });
            return response.data?.records;
        } catch (err: any) {
            if (err.response?.status === 429) {
                throw err;
            }
            console.log(`[MARKET API] data.gov.in fetch failed for ${filterKey}=${filterValue}:`, err.message);
            return null;
        }
    };

    try {
        let records = await fetchWithFilter('market', searchLocation);
        if (!records || records.length === 0) records = await fetchWithFilter('district', searchLocation);
        if (!records || records.length === 0) records = await fetchWithFilter('state', searchLocation);

        if (!records || !Array.isArray(records) || records.length === 0) return null;

        const results = records.map((r: any, index: number) => ({
            commodity: crop,
            market: r.market || searchLocation,
            is_primary: index === 0,
            is_nearby_suggestion: false,
            state: r.state || '',
            district: r.district || '',
            grade1_price: parseFloat(r.max_price || r.modal_price) || 0,
            grade2_price: parseFloat(r.modal_price) || 0,
            grade3_price: parseFloat(r.min_price || r.modal_price) || 0,
            min_price: parseFloat(r.min_price) || 0,
            max_price: parseFloat(r.max_price) || 0,
            modal_price: parseFloat(r.modal_price) || 0,
            date: r.arrival_date || new Date().toISOString().split('T')[0],
            historical_price_yesterday: 0,
            yesterday_modal_price: 0,
            source: 'data.gov.in (Agmarknet)'
        }));

        // Deduplicate by market name
        const seen = new Map();
        for (const r of results) {
            if (!seen.has(r.market)) seen.set(r.market, r);
        }
        const unique = Array.from(seen.values());

        if (unique.length > 0) {
            unique.forEach(u => u.is_primary = false);
            const exactMatch = unique.find(u =>
                u.market.toLowerCase() === searchLocation.toLowerCase() ||
                u.district.toLowerCase() === searchLocation.toLowerCase()
            );
            if (exactMatch) {
                exactMatch.is_primary = true;
            } else {
                unique[0].is_primary = true;
            }
        }

        return unique;
    } catch (err: any) {
        if (err.response?.status === 429 && retryCount < 2) {
            console.log(`[MARKET API] Rate limited (429), retrying in 1s... Attempt ${retryCount + 1}`);
            await sleep(1000);
            return fetchFromDataGov(crop, searchLocation, retryCount + 1);
        }
        return null;
    }
}

// Fallback: Fetch from Gemini AI with nearby commodity suggestion
async function fetchFromGemini(crop: string, market: string): Promise<{ data: any[] | null; isNearbySuggestion: boolean; alertMessage: string }> {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const today = new Date().toISOString().split('T')[0];

        const prompt = `You are an agricultural market data assistant for India. A farmer in "${market}" is looking for wholesale/APMC market prices for "${crop}".

Task:
1. Check if "${crop}" is commonly traded at or near "${market}" APMCs in India.
2. If YES: Provide current price estimates for "${crop}" at "${market}" and 2-3 nearby markets.
3. If NO: Find the closest APMC market or district where "${crop}" IS traded and provide those prices instead. Also flag this as a nearby suggestion.

Return ONLY a valid JSON object with this exact structure:
{
  "found_in_area": true/false,
  "alert_message": "string - message if showing nearby data, empty if exact match",
  "markets": [
    {
      "commodity": "${crop}",
      "market": "Market Name",
      "district": "District",
      "state": "State",
      "is_primary": true/false,
      "is_nearby_suggestion": true/false,
      "grade1_price": number,
      "grade2_price": number,
      "grade3_price": number,
      "modal_price": number,
      "min_price": number,
      "max_price": number,
      "yesterday_modal_price": number,
      "date": "${today}",
      "source": "AI Estimated (Gemini)"
    }
  ]
}

Prices should be in INR per quintal (100 kg). Use realistic current market estimates based on your knowledge of Indian agricultural commodity prices. Return ONLY the JSON, no explanation.`;

        const result = await model.generateContent(prompt);
        const raw = result.response.text();

        // Extract JSON from response
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start === -1 || end === -1) return { data: null, isNearbySuggestion: false, alertMessage: '' };

        const parsed = JSON.parse(raw.substring(start, end + 1));
        if (!parsed.markets || !Array.isArray(parsed.markets) || parsed.markets.length === 0) {
            return { data: null, isNearbySuggestion: false, alertMessage: '' };
        }

        const isNearby = !parsed.found_in_area;
        return {
            data: parsed.markets,
            isNearbySuggestion: isNearby,
            alertMessage: parsed.alert_message || (isNearby
                ? `"${crop}" is not commonly traded at ${market}. Showing prices from the nearest available markets instead.`
                : '')
        };
    } catch (err: any) {
        console.log('[MARKET API] Gemini fetch failed:', err.message);
        return { data: null, isNearbySuggestion: false, alertMessage: '' };
    }
}

// User must be logged in to access market data
router.get('/prices', authMiddleware, async (req, res) => {
    const { crop, market } = req.query;

    if (!crop || !market) {
        return res.status(400).json({ message: 'Crop and market/district are required' });
    }

    try {
        console.log(`[MARKET API] Fetching prices for "${crop}" at "${market}"`);

        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        // Check if we already fetched for this specific primary market today
        const todaysRecords = await MarketPrice.find({
            commodity: { $regex: new RegExp(`^${crop}$`, 'i') },
            date: { $gte: startOfToday }
        }).sort({ date: -1 });

        const hasPrimaryToday = todaysRecords.some((r: any) =>
            r.is_primary_cache === true &&
            (r.market.toLowerCase().includes((market as string).toLowerCase()) ||
                (r.district && r.district.toLowerCase().includes((market as string).toLowerCase())))
        );

        if (hasPrimaryToday && todaysRecords.length > 0) {
            console.log('[MARKET API] Returning cached market data from DB for today.');
            const processedResults = await Promise.all(todaysRecords.slice(0, 5).map(async (dbRecord: any) => {
                const dbPreviousPrice = await MarketPrice.findOne({
                    commodity: { $regex: new RegExp(`^${dbRecord.commodity}$`, 'i') },
                    market: { $regex: new RegExp(`^${dbRecord.market}$`, 'i') },
                    date: { $lt: startOfToday }
                }).sort({ date: -1 });

                const previousModalPrice = (dbPreviousPrice && dbPreviousPrice.modal_price > 0)
                    ? dbPreviousPrice.modal_price
                    : dbRecord.yesterday_modal_price;

                let percentageChange = 0;
                if (previousModalPrice && previousModalPrice > 0) {
                    percentageChange = ((dbRecord.modal_price - previousModalPrice) / previousModalPrice) * 100;
                }

                return {
                    commodity: dbRecord.commodity,
                    market: dbRecord.market,
                    district: dbRecord.district,
                    state: dbRecord.state,
                    is_primary: dbRecord.is_primary_cache || false,
                    is_nearby_suggestion: dbRecord.is_nearby_suggestion || false,
                    alert_message: dbRecord.alert_message || '',
                    grade1_price: dbRecord.grade1_price || dbRecord.max_price || 0,
                    grade2_price: dbRecord.grade2_price || dbRecord.modal_price || 0,
                    grade3_price: dbRecord.grade3_price || dbRecord.min_price || 0,
                    min_price: dbRecord.min_price || 0,
                    max_price: dbRecord.max_price || 0,
                    modal_price: dbRecord.modal_price || 0,
                    yesterday_modal_price: previousModalPrice || 0,
                    date: dbRecord.date.toISOString().split('T')[0],
                    source: dbRecord.source || 'Agmarknet',
                    previous_modal_price: previousModalPrice || null,
                    previous_date: dbPreviousPrice ? dbPreviousPrice.date.toISOString().split('T')[0] : 'Yesterday/Previous',
                    percentage_change: percentageChange.toFixed(2),
                    actual_trend: percentageChange > 0 ? 'up' : percentageChange < 0 ? 'down' : 'stable'
                };
            }));

            return res.json(processedResults);
        }

        // Step 1: Try official data.gov.in API
        let marketResults = await fetchFromDataGov(crop as string, market as string);
        let dataSourceLabel = 'data.gov.in (Agmarknet)';
        let isNearbySuggestion = false;
        let alertMessage = '';

        // Step 2: Fallback to Gemini AI if official data is unavailable
        if (!marketResults || marketResults.length === 0) {
            console.log(`[MARKET API] Official API failed/empty, falling back to Gemini for ${crop}`);
            const geminiResult = await fetchFromGemini(crop as string, market as string);
            marketResults = geminiResult.data;
            isNearbySuggestion = geminiResult.isNearbySuggestion;
            alertMessage = geminiResult.alertMessage;
            dataSourceLabel = 'AI Estimated (Gemini)';

            if (marketResults) {
                marketResults.forEach((r: any) => {
                    r.source = dataSourceLabel;
                    r.is_nearby_suggestion = isNearbySuggestion;
                    r.alert_message = alertMessage;
                });
            }
        }

        if (!marketResults || marketResults.length === 0) {
            console.log('[MARKET API] No official or AI data found for today.');
            return res.status(404).json({
                message: `No market records found for "${crop}" at "${market}" for today.`,
                code: 'NO_DATA'
            });
        }

        console.log(`[MARKET API] Got ${marketResults.length} results from ${dataSourceLabel}${isNearbySuggestion ? ' [nearby suggestion]' : ''}`);

        const processedResults = await Promise.all(marketResults.map(async (rawData: any) => {
            const currentData = {
                ...rawData,
                grade1_price: parseFloat(rawData.grade1_price) || parseFloat(rawData.max_price) || 0,
                grade2_price: parseFloat(rawData.grade2_price) || parseFloat(rawData.modal_price) || 0,
                grade3_price: parseFloat(rawData.grade3_price) || parseFloat(rawData.min_price) || 0,
                modal_price: parseFloat(rawData.modal_price) || 0,
                yesterday_modal_price: parseFloat(rawData.yesterday_modal_price) || 0
            };

            let currentDate: Date;
            if (currentData.date && currentData.date.includes('/')) {
                const parts = currentData.date.split('/');
                currentDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
            } else {
                currentDate = new Date(currentData.date);
            }
            if (isNaN(currentDate.getTime())) currentDate = new Date();
            currentData.date = currentDate;

            try {
                await MarketPrice.findOneAndUpdate(
                    {
                        commodity: { $regex: new RegExp(`^${currentData.commodity}$`, 'i') },
                        market: { $regex: new RegExp(`^${currentData.market}$`, 'i') },
                        date: {
                            $gte: new Date(new Date(currentDate).setHours(0, 0, 0, 0)),
                            $lt: new Date(new Date(currentDate).setHours(23, 59, 59, 999))
                        }
                    },
                    {
                        ...currentData,
                        is_primary_cache: currentData.is_primary,
                        is_nearby_suggestion: isNearbySuggestion,
                        alert_message: alertMessage
                    },
                    { upsert: true, new: true }
                );
            } catch (dbErr) {
                console.log('[MARKET API] DB store warning:', (dbErr as any).message);
            }

            const trueStartOfToday = new Date();
            trueStartOfToday.setHours(0, 0, 0, 0);

            const dbPreviousPrice = await MarketPrice.findOne({
                commodity: { $regex: new RegExp(`^${currentData.commodity}$`, 'i') },
                market: { $regex: new RegExp(`^${currentData.market}$`, 'i') },
                date: { $lt: trueStartOfToday }
            }).sort({ date: -1 });

            const previousModalPrice = (dbPreviousPrice && dbPreviousPrice.modal_price > 0)
                ? dbPreviousPrice.modal_price
                : currentData.yesterday_modal_price;

            let percentageChange = 0;
            if (previousModalPrice && previousModalPrice > 0) {
                percentageChange = ((currentData.modal_price - previousModalPrice) / previousModalPrice) * 100;
            }

            return {
                ...currentData,
                date: currentDate.toISOString().split('T')[0],
                is_nearby_suggestion: isNearbySuggestion,
                alert_message: alertMessage,
                previous_modal_price: previousModalPrice || null,
                previous_date: dbPreviousPrice ? dbPreviousPrice.date.toISOString().split('T')[0] : 'Yesterday/Previous',
                percentage_change: percentageChange.toFixed(2),
                actual_trend: percentageChange > 0 ? 'up' : percentageChange < 0 ? 'down' : 'stable'
            };
        }));

        res.json(processedResults);
    } catch (error: any) {
        console.error('Market API Error:', error.response?.data || error.message);
        res.status(500).json({ message: 'Error fetching market prices' });
    }
});

export default router;
