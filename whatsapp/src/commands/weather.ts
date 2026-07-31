import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { cmd } from "../config/prefixes.js";
import { fetchWeather, iconUrl } from "../../../shared/lib/openweather.js";
import { fetchImageBuffer } from "../../../shared/lib/http.js";

async function handleWeather(_sock: WASocket, msg: WAMessage, _text: string, ctx: CommandContext) {
    const location = ctx.match;
    const result = await fetchWeather(location);

    if (!result.ok) {
        await ctx.replyText(result.message);
        return;
    }

    const data = result.data;
    const condition = data.weather[0];

    const caption =
        `*Weather Information For ${data.name || location}*` +
        `\nWeather: *${condition?.main ?? "?"}*` +
        `\nDescription: *${condition?.description ?? "?"}*` +
        `\n\n*Other Information*` +
        `\nTemperature: \`${data.main.temp}°C\` (feels like \`${data.main.feels_like}°C\`)` +
        `\nPressure: \`${data.main.pressure} hPa\`` +
        `\nHumidity: \`${data.main.humidity}%\`` +
        `\nWind Speed: \`${data.wind.speed} m/s\`` +
        `\nLongitude: \`${data.coord.lon}\` | Latitude: \`${data.coord.lat}\`` +
        `\n\nQuery from: *${msg.pushName || "User"}*`;

    /*
    The icon is downloaded here rather than handed to Baileys as { image: { url } }.
    A URL send is fetched at delivery time, which the outbox cannot retry
    meaningfully once the link has expired - and it fails outright if the phone
    is offline. Bytes in hand always send.
    */
    const icon = condition ? await fetchImageBuffer(iconUrl(condition.icon)) : null;

    if (icon) {
        await ctx.reply({ image: icon, caption, mimetype: "image/png" });
    } else {
        await ctx.replyText(caption);
    }
}

const command: Command = {
    name: "weather",
    description: "Get current weather for a location",
    usage: `${cmd("weather")} <city>`,
    requiresArgs: true,
    handler: handleWeather,
};

export default command;
