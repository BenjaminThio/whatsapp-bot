/**
 * index.ts - relasma/src/weather/index.ts
 *
 * /weather <city> - conditions, with the icon
 * /temp <city>    - temperature in °C, °K and °F
 *
 * Both used to inline the same fetch against a hardcoded pro.openweathermap.org
 * URL, and both reported any non-200 as "Invalid Location" - so a missing API
 * key looked exactly like a typo in the city name. The call is shared with the
 * WhatsApp bot now and distinguishes the failure modes.
 */

import { InputFile } from "grammy";
import { cmd, feature, type Ctx } from "../lib/command.js";
import { fetchWeather, iconUrl, type OpenWeatherResponse } from "../../../shared/lib/openweather.js";
import { fetchImageBuffer } from "../../../shared/lib/http.js";

/** °C in all three scales, the way both bots print it. */
const scales = (c: number): string =>
    `${c}°C / ${(c + 273.15).toFixed(2)}°K / ${((c * 9) / 5 + 32).toFixed(2)}°F`;

const weather = cmd("weather", {
    description: "Current weather for a location",
    args: "<city>",
    usageHint: "Usage: /weather <city>\nExample: /weather Kampar",
    requiresArgs: true,
}, async (ctx: Ctx) => {
    const result = await fetchWeather(ctx.match);
    if (!result.ok) { await ctx.reply(result.message); return; }

    const data: OpenWeatherResponse = result.data;
    const condition = data.weather[0];

    const caption =
        `Weather for ${data.name || ctx.match}\n` +
        `Weather: ${condition?.main ?? "?"}\n` +
        `Description: ${condition?.description ?? "?"}\n\n` +
        `Temperature: ${scales(data.main.temp)}\n` +
        `Feels like: ${data.main.feels_like}°C\n` +
        `Pressure: ${data.main.pressure} hPa\n` +
        `Humidity: ${data.main.humidity}%\n` +
        `Wind: ${data.wind.speed} m/s at ${data.wind.deg}°\n` +
        `Coords: ${data.coord.lat}, ${data.coord.lon}\n\n` +
        `Queried by ${ctx.who}`;

    /*
    The icon is downloaded rather than handed to Telegram as a URL: Telegram
    fetches it server-side, and a transient failure there loses the whole
    message rather than just the picture.
    */
    const icon = condition ? await fetchImageBuffer(iconUrl(condition.icon)) : null;

    if (icon) await ctx.tg.replyWithPhoto(new InputFile(icon, "weather.png"), { caption });
    else await ctx.reply(caption);
});

const temp = cmd("temp", {
    description: "Temperature for a location",
    args: "<city>",
    usageHint: "Usage: /temp <city>\nExample: /temp Kampar",
    requiresArgs: true,
}, async (ctx: Ctx) => {
    const result = await fetchWeather(ctx.match);
    if (!result.ok) { await ctx.reply(result.message); return; }

    const m = result.data.main;
    await ctx.reply(
        `Temperature for ${result.data.name || ctx.match}\n\n` +
        `Now:  ${scales(m.temp)}\n` +
        `Min:  ${scales(m.temp_min)}\n` +
        `Max:  ${scales(m.temp_max)}\n` +
        `Feels like: ${scales(m.feels_like)}\n\n` +
        `Queried by ${ctx.who}`
    );
});

export default feature("weather", [weather, temp]);
