import { userStore } from '../../../shared/db/user-store.js';
import { Callback } from '../types.js';
import { CategoryRecord, ShopRecord, ShopCallback } from './index.js';

type ShopItems = CategoryRecord<string[]>;
export type ShopItemIndexes = CategoryRecord<number[]>;
export type Skins = CategoryRecord<number>;
export const SHOP_ITEMS: ShopItems = {
    [Callback.SNAKE]: {
        background: ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛️', '⬜️', '🟫'],
        barrier: ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛️', '⬜️', '🟫'],
        head: ['😀', '😃', '😄', '😁', '😆', '🥹', '😅', '😂', '🤣', '🥲', '☺️', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥸', '🤩', '🥳', '🙂', '🙂‍↕️', '😏', '😒', '🙂', '🙂‍↔️', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😶‍🌫️', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🫣', '🤭', '🫢', '🫡', '🤫', '🫠', '🤥', '😶', '🫥', '😐', '🫤', '😑', '🫨', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '🫩', '😴', '🤤', '😪', '😮‍💨', '😵', '😵', '😵‍💫', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '🤡', '💀', '☠️', '👽', '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🌞', '🌝', '🌚', '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐔', '🐧', '🐦', '🐤', '🐴', '🦄', '🐲'],
        body: ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫️', '⚪️', '🟤'],
        food: ['🍄', '🍄‍🟫', '🍏', '🍎', '🍐', '🍊', '🍋', '🍋‍🟩', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🫛', '🥦', '🥬', '🥒', '🌶', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🫜', '🍠', '🫚', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🥫', '🍝', '🍜', '🍲', '🫙', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🫘', '🍯', '🥛', '🫗', '🍼', '🫖', '☕', '🍵', '🧃', '🥤', '🧋', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾', '🧊'],
    },
    [Callback.SOKOBAN]: {
        background: ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛️', '⬜️', '🟫'],
        barrier: ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛️', '⬜️', '🟫'],
        player: ['😀', '😃', '😄', '😁', '😆', '🥹', '😅', '😂', '🤣', '🥲', '☺️', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥸', '🤩', '🥳', '🙂', '🙂‍↕️', '😏', '😒', '🙂', '🙂‍↔️', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😶‍🌫️', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🫣', '🤭', '🫢', '🫡', '🤫', '🫠', '🤥', '😶', '🫥', '😐', '🫤', '😑', '🫨', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '🫩', '😴', '🤤', '😪', '😮‍💨', '😵', '😵', '😵‍💫', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '🤡', '💀', '☠️', '👽', '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🌞', '🌝', '🌚', '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐔', '🐧', '🐦', '🐤', '🐴', '🦄', '🐲'],
        box: ['📦', '💵', '💴', '💶', '💷', '🪙', '💰', '💎', '⚽️', '🏀', '🏈', '⚾️', '🥎', '🏐', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🎁', '✉️', '📧', '💌', '💍', '👝', '👛', '👜', '💼', '🎒', '🧳', '⭐️', '🌟', '✨', '☄️', '🩷', '❤️', '🧡', '💛', '💚', '🩵', '💙', '💜', '🖤', '🩶', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝'],
        destination: ['❌', '🥅', '⛳️', '🏖', '🏝', '🏜', '🌋', '⛰', '🏔', '🗻', '🏕', '⛺️', '🛖', '🏠', '🏡', '🏘', '🏚', '🏭', '🏢', '🏬', '🏣', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫', '🏩', '💒', '🏛', '⛪️', '🕌', '🕍', '🛕', '⛩', '🗾', '🎑', '🏞', '🌅', '🌄', '🌠', '🎇', '🎆', '🌇', '🌆', '🏙', '🌃', '🌌', '🌉', '🌁', '📪', '📫', '📬', '📭', '📮', '🗑']
    }
};

export const INITIAL_DIAMOND_QUANTITY: number = 1000;
export const INITIAL_SKINS: Skins = {
    [Callback.SNAKE]: {
        background: 7,
        barrier: 5,
        head: 59,
        body: 2,
        food: 3
    },
    [Callback.SOKOBAN]: {
        background: 7,
        barrier: 5,
        player: 5,
        box: 0,
        destination: 0
    }
} as const;
export const INITIAL_PURCHASED_SHOP_ITEMS: ShopItemIndexes = {
    [Callback.SNAKE]: {
        background: [7],
        barrier: [5],
        head: [59],
        body: [2],
        food: [3]
    },
    [Callback.SOKOBAN]: {
        background: [7],
        barrier: [5],
        player: [5],
        box: [0],
        destination: [0]
    }
} as const;
export const INITIAL_STARRED_SHOP_ITEMS: ShopItemIndexes = {
    [Callback.SNAKE]: {
        background: [],
        barrier: [],
        head: [],
        body: [],
        food: []
    },
    [Callback.SOKOBAN]: {
        background: [],
        barrier: [],
        player: [],
        box: [],
        destination: []
    }
} as const;

export interface ShopData
{
    diamonds: number;
    purchasedShopItems: ShopItemIndexes;
    equippedSkins: Skins;
    starredShopItems: ShopItemIndexes;
}

// Postgres-backed, shared with the WhatsApp bot. Plain JSON, so no codec needed.
const store = userStore<ShopData>('shop');

/** A brand-new shopper: starting diamonds, default skins, nothing starred. */
export const freshShopData = (): ShopData => ({
    diamonds: INITIAL_DIAMOND_QUANTITY,
    purchasedShopItems: structuredClone(INITIAL_PURCHASED_SHOP_ITEMS) as ShopItemIndexes,
    equippedSkins: structuredClone(INITIAL_SKINS) as Skins,
    starredShopItems: structuredClone(INITIAL_STARRED_SHOP_ITEMS) as ShopItemIndexes,
});

export const userExists = (userId: number): Promise<boolean> => store.exists(userId);

/**
 * Create a shop record for a first-time user.
 *
 * The Firestore version wrote only purchasedShopItems and equippedSkins, so a
 * new shopper had no `diamonds` and no `starredShopItems` field at all - the
 * first read then produced NaN when the code did arithmetic on undefined. The
 * whole record is written now.
 */
export async function initializeShopData(userId: number, data: ShopData): Promise<void> {
    if (!(await store.create(userId, data))) {
        console.warn(`[shop] record already exists for ${userId} - initialize ignored.`);
    }
}

export const updateShopData = (userId: number, data: ShopRecord): Promise<void> =>
    store.set(userId, {
        diamonds: data.diamonds,
        purchasedShopItems: data.purchasedShopItems,
        equippedSkins: data.equippedSkins,
        starredShopItems: data.starredShopItems,
    });

export const updateShopField = <Field extends keyof ShopData>(
    userId: number,
    field: Field,
    value: ShopData[Field]
): Promise<void> => store.setField(userId, field, value);

/**
 * The user's shop record, created with the starting balance on first access.
 *
 * Previously this cast a missing document to ShopData, so anyone who opened the
 * shop before it had been initialised got `undefined` and crashed on
 * `data.diamonds`. Now the first read sets them up.
 */
export const getShopData = (userId: number): Promise<ShopData> =>
    store.getOrCreate(userId, freshShopData);

/**
 * Spend diamonds and record a purchase in one atomic read-modify-write.
 *
 * Buying from two chats at once could previously double-spend: both reads saw
 * the same balance, and the second write overwrote the first. mutate() holds a
 * row lock for the duration.
 *
 * Returns false (and changes nothing) when the user cannot afford it.
 */
export async function purchaseItem<Game extends ShopCallback>(
    userId: number,
    cost: number,
    category: Game,
    group: keyof ShopItemIndexes[Game] & string,
    index: number
): Promise<boolean> {
    let bought = true;

    await store.mutate(userId, (current) => {
        const data = current ?? freshShopData();

        const owned = (data.purchasedShopItems[category][group] ?? []) as number[];

        // Already owned is a no-op, not a failure - re-tapping a bought skin
        // must never charge twice.
        if (owned.includes(index)) {
            bought = false;
            return data;
        }
        if (data.diamonds < cost) {
            bought = false;
            return data;                       // unchanged
        }

        return {
            ...data,
            diamonds: data.diamonds - cost,
            purchasedShopItems: {
                ...data.purchasedShopItems,
                [category]: {
                    ...data.purchasedShopItems[category],
                    [group]: [...owned, index],
                },
            },
        };
    });

    return bought;
}

export const deleteShopDoc = (userId: number): Promise<boolean> => store.remove(userId);