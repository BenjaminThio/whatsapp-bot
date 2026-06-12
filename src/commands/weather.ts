import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";

const API_KEY = process.env.OPEN_WEATHER_API_KEY;

interface OpenWeatherResponse {
    coord: { lon: number; lat: number; };
    weather: [{ id: number; main: string; description: string; icon: string; }];
    main: { temp: number; feels_like: number; temp_min: number; temp_max: number; pressure: number; humidity: number; };
    wind: { speed: number; deg: number; };
    name: string;
}

async function handleWeather(sock: any, msg: WAMessage, text: string) {
    if (!msg.key.remoteJid) return;
    const location = text.slice("!weather ".length).trim();

    if (!location) {
        await sock.sendMessage(msg.key.remoteJid, { text: "Usage: `!weather <Location>`" });
        return;
    }

    try {
        const response = await fetch(`http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${API_KEY}&units=metric`);
        if (!response.ok) {
            await sock.sendMessage(msg.key.remoteJid, { text: `❌ Invalid Location: ${location}` });
            return;
        }

        const data: OpenWeatherResponse = await response.json() as OpenWeatherResponse;
        const iconUrl = `http://openweathermap.org/img/wn/${data.weather[0].icon}@2x.png`;

        const caption = `*Weather Information For ${location}*` +
            `\nWeather: *${data.weather[0].main}*` +
            `\nDescription: *${data.weather[0].description}*` +
            `\n\n*Other Information*` +
            `\nPressure: \`${data.main.pressure} hPa\`` +
            `\nHumidity: \`${data.main.humidity}%\`` +
            `\nWind Speed: \`${data.wind.speed} m/s\`` +
            `\nLongitude: \`${data.coord.lon}\` | Latitude: \`${data.coord.lat}\`` +
            `\n\nQuery from: *${msg.pushName || "User"}*`;

        await sock.sendMessage(msg.key.remoteJid, { image: { url: iconUrl }, caption });
    } catch (err) {
        console.error("Weather error:", err);
        await sock.sendMessage(msg.key.remoteJid, { text: "❌ API Error occurred." });
    }
}

const command: Command = {
    name: "weather",
    description: "Get current weather for a location",
    usage: "!weather <city>",
    requiresArgs: true,
    handler: handleWeather,
};

export default command;