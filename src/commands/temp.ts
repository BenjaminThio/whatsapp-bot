import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";

const API_KEY = process.env.OPEN_WEATHER_API_KEY;

async function handleTemp(sock: any, msg: WAMessage, text: string) {
    if (!msg.key.remoteJid) return;
    const location = text.slice("!temp ".length).trim();

    if (!location) {
        await sock.sendMessage(msg.key.remoteJid, { text: "Usage: `!temp <Location>`" });
        return;
    }

    try {
        const response = await fetch(`http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${API_KEY}&units=metric`);
        if (!response.ok) {
            await sock.sendMessage(msg.key.remoteJid, { text: `❌ Invalid Location: ${location}` });
            return;
        }

        const data = await response.json() as any;
        const temp = data.main.temp;

        const responseText = `*Temperature Information For ${location}*` +
            `\nTemperature: \`${temp}°C / ${(temp + 273.15).toFixed(2)}°K / ${((temp * 9) / 5 + 32).toFixed(2)}°F\`` +
            `\nMin: \`${data.main.temp_min}°C\`` +
            `\nMax: \`${data.main.temp_max}°C\`` +
            `\nFeels Like: \`${data.main.feels_like}°C\`` +
            `\n\nQuery by: *${msg.pushName || "User"}*`;

        await sock.sendMessage(msg.key.remoteJid, { text: responseText });
    } catch (err) {
        console.error("Temp error:", err);
        await sock.sendMessage(msg.key.remoteJid, { text: "❌ API Error occurred." });
    }
}

const command: Command = {
    name: "temp",
    description: "Get temperature for a location",
    usage: "!temp <city>",
    requiresArgs: true,
    handler: handleTemp,
};

export default command;