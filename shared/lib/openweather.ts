/**
 * openweather.ts - src/lib/openweather.ts
 *
 * !temp and !weather hit the same endpoint with the same key and the same
 * failure modes; only the formatting differs. The call lives here so a missing
 * API key is reported once, properly, instead of surfacing as "Invalid Location".
 */

import { fetchWithTimeout } from "./http.js";

const API_BASE = "https://api.openweathermap.org/data/2.5/weather";

export interface OpenWeatherResponse {
    coord: { lon: number; lat: number };
    weather: { id: number; main: string; description: string; icon: string }[];
    main: {
        temp: number; feels_like: number; temp_min: number; temp_max: number;
        pressure: number; humidity: number;
    };
    wind: { speed: number; deg: number };
    name: string;
}

export type WeatherResult =
    | { ok: true; data: OpenWeatherResponse }
    | { ok: false; reason: "no_key" | "not_found" | "error"; message: string };

export function iconUrl(icon: string): string {
    return `https://openweathermap.org/img/wn/${icon}@2x.png`;
}

export async function fetchWeather(location: string): Promise<WeatherResult> {
    const apiKey = process.env["OPEN_WEATHER_API_KEY"];
    if (!apiKey) {
        return { ok: false, reason: "no_key", message: "❌ *OPEN_WEATHER_API_KEY* is not set in the environment." };
    }

    try {
        const url = `${API_BASE}?q=${encodeURIComponent(location)}&appid=${apiKey}&units=metric`;
        const res = await fetchWithTimeout(url, { timeoutMs: 10_000 });

        if (res.status === 404) {
            return { ok: false, reason: "not_found", message: `❌ Unknown location: *${location}*` };
        }
        if (res.status === 401) {
            return { ok: false, reason: "no_key", message: "❌ OpenWeather rejected the API key." };
        }
        if (!res.ok) {
            return { ok: false, reason: "error", message: `❌ OpenWeather returned ${res.status}.` };
        }

        return { ok: true, data: await res.json() as OpenWeatherResponse };
    } catch (err: any) {
        console.error("[openweather] request failed:", err?.message ?? err);
        return { ok: false, reason: "error", message: "❌ Could not reach OpenWeather. Try again shortly." };
    }
}
