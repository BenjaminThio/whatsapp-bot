import { Composer, Context, InlineKeyboard } from "grammy";

const testModule: Composer<Context> = new Composer();

testModule.command('test', async (ctx) => {
    ctx.reply('test', {reply_markup: new InlineKeyboard().text('test', '9 12345 7')});
});

testModule.callbackQuery(new RegExp('^9 (\\d+) ([0-9])*$'), async (ctx) => {
    console.log(ctx.from.id);
    console.log(ctx.from.id.toString().length);
    console.log(ctx.callbackQuery.data);
    console.log(ctx.callbackQuery.data.length);
    console.log(ctx.match);
});

export default testModule;