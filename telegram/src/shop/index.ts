import { CallbackQueryContext, CommandContext, Composer, Context, InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import { Callback, Coord } from "../types.js";
import { getShopData, INITIAL_DIAMOND_QUANTITY, INITIAL_PURCHASED_SHOP_ITEMS, INITIAL_SKINS, INITIAL_STARRED_SHOP_ITEMS, initializeShopData, SHOP_ITEMS, ShopData, Skins, updateShopData, userExists } from "./database.js";
import { renderSnakeMap } from "../snake/index.js";
import { renderSokobanMap } from "../sokoban/index.js";
import { reshuffle } from "../sokoban/index.js";
import { SnakeGameData } from "../snake/database.js";
import { SokobanGameData } from "../sokoban/database.js";
import { EmojiDefinition, getEmojiDefinition } from "../emojipedia/index.js";
import { MaybeInaccessibleMessage } from "grammy/types";
import { toTitleCase } from "../../../shared/lib/text.js";

enum Subcallback
{
    NONE,
    BACK,
    PREVIOUS,
    NEXT,
    PURCHASE_SKIN,
    EQUIP_SKIN,
    DEFINITION,
    STAR,
    DISPLAY_STARRED
}
interface ShopScreenView
{
    text: string,
    keyboard: InlineKeyboard,
    imageSource?: string | InputFile
}
export interface ShopRecord extends ShopData
{
    previewSkins: Skins;
    pageCount: number;
    pageIdx: number;
    showStarred: boolean;
}
// Shop Supported Callbacks
export type ShopCallback = Callback.SNAKE | Callback.SOKOBAN;
type CategoryKeys = {
    [Callback.SNAKE]: 'background' | 'barrier' | 'head' | 'body' | 'food',
    [Callback.SOKOBAN]: 'background' | 'barrier' | 'player' | 'box' | 'destination'
}
export type CategoryRecord<T> = {
    [Game in ShopCallback]: Record<CategoryKeys[Game], T>
}
type Categories = {
    [Game in ShopCallback]: readonly CategoryKeys[Game][];
}
const CATEGORIES: Categories = {
    [Callback.SNAKE]: ['background', 'barrier', 'head', 'body', 'food'],
    [Callback.SOKOBAN]: ['background', 'barrier', 'player', 'box', 'destination']
};
const HEADER: string = '<b>Shop</b>';
const SNAKE_MAP_PREVIEW: SnakeGameData = {parts: [new Coord(4, 7), new Coord(5, 7), new Coord(5, 6), new Coord(5, 5), new Coord(5, 4)], foodCoord: new Coord(2, 7)};
const SOKOBAN_MAP_PREVIEW: SokobanGameData = reshuffle();
const SKIN_PRICE: number = 200;
const MAX_SKINS_PER_PAGE: number = 80;
const shopModule = new Composer();
export const shops: Record<number, ShopRecord> = {};

export async function ensureShopDataInitialized(userId: number)
{
    if (!(userId in shops))
    {
        if (await userExists(userId))
        {
            const shopData: ShopData = await getShopData(userId);

            shops[userId] = {
                diamonds: shopData.diamonds,
                purchasedShopItems: shopData.purchasedShopItems,
                equippedSkins: shopData.equippedSkins,
                starredShopItems: shopData.starredShopItems,
                previewSkins: structuredClone(shopData.equippedSkins),
                pageCount: 0,
                pageIdx: 0,
                showStarred: false
            };
        }
        else
        {
            shops[userId] = {
                diamonds: INITIAL_DIAMOND_QUANTITY,
                purchasedShopItems: structuredClone(INITIAL_PURCHASED_SHOP_ITEMS),
                equippedSkins: structuredClone(INITIAL_SKINS),
                starredShopItems: structuredClone(INITIAL_STARRED_SHOP_ITEMS),
                previewSkins: structuredClone(INITIAL_SKINS),
                pageCount: 0,
                pageIdx: 0,
                showStarred: false
            };
            await initializeShopData(userId, shops[userId]);
        }
    }
}

shopModule.command('shop', async (ctx: CommandContext<Context>): Promise<void> => {
    if (ctx.from === undefined)
    {
        ctx.reply('`ctx.from` is undefined.');
        return;
    }

    const userId: number = ctx.from.id;

    await ensureShopDataInitialized(userId);

    shops[userId].pageIdx = 0;

    await ctx.reply(
        HEADER, {
            reply_markup: new InlineKeyboard().text('Snake', callback(userId, Subcallback.NONE, Callback.SNAKE)).row()
                                              .text('Sokoban', callback(userId, Subcallback.NONE, Callback.SOKOBAN)).row()
                                              .text('♻️', `${Callback.DELETE} ${userId}`),
            parse_mode: 'HTML'
        }
    );
});

shopModule.callbackQuery(new RegExp(`^${Callback.SHOP}(?:\\s\\d+)*$`), async (ctx: CallbackQueryContext<Context>): Promise<void> => {
    if (ctx.from === undefined)
    {
        ctx.editMessageText('`ctx.from` is undefined.');
        return;
    }

    const userId: number = ctx.from.id;
    const callbackParams: number[] = ctx.callbackQuery.data.split(' ').map(Number);
    const ownerId: number = callbackParams[1];
    const subcallback: Subcallback = callbackParams[2];

    if (userId !== ownerId)
    {
        await ctx.answerCallbackQuery({
            text: 'This is not your property.',
            show_alert: true
        });
        return;
    }

    await ensureShopDataInitialized(userId);

    if (callbackParams.length < 3)
        throw new Error('The callback query must have at least 3 or more parameters.');

    switch (subcallback)
    {
        case Subcallback.BACK:
            shops[userId].pageIdx = 0;
            callbackParams[2] = Subcallback.NONE;
            callbackParams.pop();
            break;
    }

    const game: ShopCallback = callbackParams[3];
    const categoryIdx: number | undefined = callbackParams[4];
    const skinIdx: number | undefined = callbackParams[5];
    const shopScreenView: ShopScreenView = await renderShopScreen(userId, ownerId, subcallback, game, categoryIdx, skinIdx);

    if (shopScreenView.imageSource !== undefined)
    {
        await ctx.editMessageMedia(InputMediaBuilder.photo(shopScreenView.imageSource, {
            caption: shopScreenView.text,
            parse_mode: 'HTML'
        }), { reply_markup: shopScreenView.keyboard });
    }
    else
    {
        const message: MaybeInaccessibleMessage | undefined = ctx.callbackQuery.message;

        if (message !== undefined)
        {
            if (message.text !== undefined)
            {
                await ctx.editMessageText(shopScreenView.text, {
                    reply_markup: shopScreenView.keyboard,
                    parse_mode: 'HTML'
                });
            }
            else if (message.caption !== undefined)
            {
                await ctx.deleteMessage();
                await ctx.reply(shopScreenView.text, {
                    reply_markup: shopScreenView.keyboard,
                    parse_mode: 'HTML'
                });
            }
            else
            {
                throw new Error('Message has no text or caption.');
            }
        }
        else
        {
            throw new Error('Message is undefined.');
        }
    }
});

function renderPreview(userId: number, game: ShopCallback): string
{
    let renderer: string = '';

    renderer += '\n<pre><code class="language-Preview">';
    switch (game)
    {
        case Callback.SNAKE:
            renderer += renderSnakeMap(shops[userId].previewSkins, SNAKE_MAP_PREVIEW);
            break;
        case Callback.SOKOBAN:
            renderer += renderSokobanMap(shops[userId].previewSkins, SOKOBAN_MAP_PREVIEW);
            break;
    }
    renderer += '</code></pre>';

    return renderer;
}

function callback(ownerId: number, subcallback: Subcallback, game: ShopCallback, categoryIdx?: number, skinIdx?: number)
{
    return `${Callback.SHOP} ${ownerId} ${subcallback} ${game} ${categoryIdx ?? ''} ${skinIdx ?? ''}`.trimEnd();
}

async function renderShopScreen<Game extends ShopCallback>(userId: number, ownerId: number, subcallback: Subcallback, game: Game, categoryIdx?: number, skinIdx?: number): Promise<ShopScreenView>
{
    let text: string = HEADER;

    if (game === undefined)
    {
        return {
            text: text,
            keyboard: new InlineKeyboard().text('Snake', callback(userId, Subcallback.NONE, Callback.SNAKE)).row()
                                          .text('Sokoban', callback(userId, Subcallback.NONE, Callback.SOKOBAN)).row()
                                          .text('♻️', `${Callback.DELETE} ${ownerId}`)
        };
    }
    else
    {
        const keyboard: InlineKeyboard = new InlineKeyboard();
        const categories: Categories[Game] = CATEGORIES[game];

        // Categories display page
        if (categoryIdx === undefined)
        {
            text += `${renderPreview(userId, game)}\n<b>Diamonds:</b> <code>${shops[userId].diamonds} 💎</code>`;

            for (let i: number = 0; i < categories.length; i++)
            {
                keyboard.text(toTitleCase(categories[i]), callback(ownerId, Subcallback.NONE, game, i));

                if (i + 1 < categories.length)
                {
                    keyboard.row();
                }
            }
        }
        else
        {
            switch (subcallback)
            {
                case Subcallback.DISPLAY_STARRED:
                    shops[userId].showStarred = !shops[userId].showStarred;
                    break;
            }

            const category: CategoryKeys[Game] = categories[categoryIdx];
            const shopItems: string[] = SHOP_ITEMS[game][category];
            const starredShopItemIndexes: number[] = shops[userId].starredShopItems[game][category];
            const shopItemsDisplay: string[] = shops[userId].showStarred ? shopItems.filter((_item: string, idx: number) => starredShopItemIndexes.includes(idx)) : shopItems;

            // Skins display page
            if (skinIdx === undefined)
            {
                let counter: number = 0;

                shops[userId].previewSkins = structuredClone(shops[userId].equippedSkins);
                shops[userId].pageCount = Math.ceil(shopItemsDisplay.length / MAX_SKINS_PER_PAGE);

                switch (subcallback)
                {
                    case Subcallback.PREVIOUS:
                        if (shops[userId].pageIdx - 1 >= 0)
                        {
                            shops[userId].pageIdx--;
                        }
                        else
                        {
                            shops[userId].pageIdx = shops[userId].pageCount - 1;
                        }
                        break;
                    case Subcallback.NEXT:
                        if (shops[userId].pageIdx + 1 < shops[userId].pageCount)
                        {
                            shops[userId].pageIdx++;
                        }
                        else
                        {
                            shops[userId].pageIdx = 0;
                        }
                        break;
                }

                /*
                for (let i = MAX_SKINS_PER_PAGE * pageIdx; i < (shopItems.length > MAX_SKINS_PER_PAGE ? MAX_SKINS_PER_PAGE * (pageIdx + 1) : shopItems.length); i++)
                {
                    if (shopItems[i] === undefined)
                        break;

                    keyboard.text(shopItems[i], callback(subcallback, game, categoryIdx, i));
                    counter++;
                    
                    switch (counter)
                    {
                        case 8:
                            counter = 0;
                            keyboard.row();
                            break;
                    }
                }
                */

                for (let i = MAX_SKINS_PER_PAGE * shops[userId].pageIdx; i < MAX_SKINS_PER_PAGE * (shops[userId].pageIdx + 1); i++)
                {
                    if (shopItemsDisplay[i] === undefined)
                        keyboard.text(' ');
                    else
                        keyboard.text(shopItemsDisplay[i], callback(ownerId, Subcallback.NONE, game, categoryIdx, shopItems.indexOf(shopItemsDisplay[i])));
                    counter++;
                    
                    switch (counter)
                    {
                        case 8:
                            counter = 0;
                            keyboard.row();
                            break;
                    }
                }

                text += `${renderPreview(userId, game)}\n<b>Diamonds:</b> <code>${shops[userId].diamonds} 💎</code>`;

                if (shopItemsDisplay.length > MAX_SKINS_PER_PAGE)
                    keyboard.row().text('⬅️', callback(ownerId, Subcallback.PREVIOUS, game, categoryIdx)).text(shops[userId].pageCount === 0 ? '-' : `${shops[userId].pageIdx + 1}/${shops[userId].pageCount}`).text('➡️', callback(ownerId, Subcallback.NEXT, game, categoryIdx));
                else
                    keyboard.row().text('🚫').text(shops[userId].pageCount === 0 ? '-' : `${shops[userId].pageIdx + 1}/${shops[userId].pageCount}`).text('🚫');
                keyboard.row().text(`Show Starred ${shops[userId].showStarred ? '🌟' : '⭐️'}`, callback(ownerId, Subcallback.DISPLAY_STARRED, game, categoryIdx));
            }
            else
            {
                const purchasedItems: number[] = shops[userId].purchasedShopItems[game][category];

                switch (subcallback)
                {
                    case Subcallback.PURCHASE_SKIN:
                        if (shops[userId].diamonds - SKIN_PRICE >= 0)
                        {
                            shops[userId].diamonds -= SKIN_PRICE;
                            purchasedItems.push(skinIdx);
                        }
                        break;
                    case Subcallback.EQUIP_SKIN:
                        (shops[userId].equippedSkins[game] as Record<CategoryKeys[Game], number>)[category] = skinIdx;
                        break;
                    case Subcallback.DEFINITION: {
                        const emojiDefnition: EmojiDefinition = await getEmojiDefinition(shopItemsDisplay[skinIdx]);

                        // Emoji definition page
                        return {
                            text: emojiDefnition.caption,
                            keyboard: new InlineKeyboard().text('🔙', callback(ownerId, Subcallback.NONE, game, categoryIdx, skinIdx)).row()
                                                          .text('♻️', `${Callback.DELETE} ${ownerId}`),
                            imageSource: emojiDefnition.imageSource
                        };
                    }
                    case Subcallback.STAR: {
                        if (starredShopItemIndexes.includes(skinIdx))
                        {
                            starredShopItemIndexes.splice(starredShopItemIndexes.indexOf(skinIdx), 1);
                        }
                        else
                        {
                            starredShopItemIndexes.push(skinIdx);
                        }
                        break;
                    }
                }
                await updateShopData(userId, shops[userId]);

                (shops[userId].previewSkins[game] as Record<CategoryKeys[Game], number>)[category] = skinIdx;
                text += `${renderPreview(userId, game)}\n<b>Diamonds:</b> <code>${shops[userId].diamonds} 💎</code>`;

                // Purchased skin page
                if (purchasedItems.includes(skinIdx))
                {
                    const equippedSkinIdx: number = shops[userId].equippedSkins[game][category];

                    text += `<pre><code class='language-Skin Info'><b>Character:</b> ${shopItemsDisplay[skinIdx]}\n<b>Status:</b> Owned\n<b>Equipped:</b> ${equippedSkinIdx === skinIdx}\n<b>Starred:</b> ${starredShopItemIndexes.includes(skinIdx)}</code></pre>`;

                    // Skin equip page
                    if (equippedSkinIdx !== skinIdx)
                    {
                        text += `<pre><code class='language-Alert'>Are you sure you want to change the skin\nfrom ${shopItemsDisplay[equippedSkinIdx]} to ${shopItemsDisplay[skinIdx]}?</code></pre>`;
                        keyboard.text('Equip Skin', callback(ownerId, Subcallback.EQUIP_SKIN, game, categoryIdx, skinIdx));
                    }
                }
                // Skin purchase page
                else
                {
                    text += `<pre><code class='language-Skin Info'><b>Character:</b> ${shopItemsDisplay[skinIdx]}\n<b>Price:</b> 200 💎\n<b>Status:</b> Not Owned\n<b>Starred:</b> ${starredShopItemIndexes.includes(skinIdx)}</code></pre>`;
                    keyboard.text('Purchase Skin', callback(ownerId, Subcallback.PURCHASE_SKIN, game, categoryIdx, skinIdx));
                }
                keyboard.row().text(starredShopItemIndexes.includes(skinIdx) ? 'Starred 🌟' : 'Star ⭐️', callback(ownerId, Subcallback.STAR, game, categoryIdx, skinIdx))
                        .row().text('📖 Definition 🔎', callback(ownerId, Subcallback.DEFINITION, game, categoryIdx, skinIdx));
            }
        }

        keyboard.row()
                .text('🔙', callback(ownerId, Subcallback.BACK, game, categoryIdx, skinIdx));

        return { text: text, keyboard: keyboard.row().text('♻️', `${Callback.DELETE} ${ownerId}`) };
    }
}

export default shopModule;