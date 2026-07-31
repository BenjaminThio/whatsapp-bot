import { CallbackQueryContext, Composer, Context } from "grammy";
import { Callback } from "../types.js";

const deleteModule: Composer<Context> = new Composer();

deleteModule.callbackQuery(new RegExp(`^${Callback.DELETE} (:?\\d+)$`), async (ctx: CallbackQueryContext<Context>) => {
    const ownerId: number = Number(ctx.match[1]);
    const userId: number = ctx.from.id;

    if (ownerId === userId)
    {
        ctx.deleteMessage();
    }
    else
    {
        ctx.answerCallbackQuery("You cannot delete others' property.");
    }
});

export default deleteModule;