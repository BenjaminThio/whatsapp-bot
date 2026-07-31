import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { cmd } from "../config/prefixes.js";
import { fetchWeather } from "../../../shared/lib/openweather.js";

async function handleTemp(_sock: WASocket, msg: WAMessage, _text: string, ctx: CommandContext) {
    const location = ctx.match;
    const result = await fetchWeather(location);

    if (!result.ok) {
        await ctx.replyText(result.message);
        return;
    }

    const { temp, temp_min, temp_max, feels_like } = result.data.main;

    await ctx.replyText(
        `*Temperature Information For ${result.data.name || location}*` +
        `\nTemperature: \`${temp}°C / ${(temp + 273.15).toFixed(2)}°K / ${((temp * 9) / 5 + 32).toFixed(2)}°F\`` +
        `\nMin: \`${temp_min}°C\`` +
        `\nMax: \`${temp_max}°C\`` +
        `\nFeels Like: \`${feels_like}°C\`` +
        `\n\nQuery by: *${msg.pushName || "User"}*`
    );
}

const command: Command = {
    name: "temp",
    description: "Get temperature for a location",
    usage: `${cmd("temp")} <city>`,
    requiresArgs: true,
    handler: handleTemp,
};

export default command;
