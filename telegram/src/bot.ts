// Fills in anything shared/.env provides that this bot has not set itself.
// Must come before BOT_TOKEN and friends are read below.
import "../../shared/env.js";
import { Api, Bot, Context, type CommandContext, type RawApi } from "grammy";

const token: string | undefined = process.env.BOT_TOKEN;

if (token === undefined)
    throw new Error("`BOT_TOKEN` is unset.");

export const bot: Bot<Context, Api<RawApi>> = new Bot(token);

bot.command("start", async (ctx: CommandContext<Context>) => {
    await ctx.reply("Hello Mum!");
});