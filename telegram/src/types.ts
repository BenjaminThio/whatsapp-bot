interface Equal<T> {
    equals(other: T): boolean;
}

export class Coord implements Equal<Coord> {
    x: number;
    y: number;

    constructor(x: number, y:number) {
        this.x = x;
        this.y = y;
    }

    public equals(other: Coord): boolean {
        if (!(other instanceof Coord)) return false;

        return this.x === other.x && this.y === other.y;
    }
}

export const contains = (arr: readonly Coord[], a: Coord | number, b?: number): boolean => arr.some(coord => coord.equals(b === undefined ? a as Coord : new Coord(a as number, b)));

export enum Movement {
    UP,
    LEFT,
    DOWN,
    RIGHT
}

export enum Callback {
    SNAKE,
    SOKOBAN,
    CALCULATOR,
    TIC_TAC_TOE,
    CHESS,
    SHOP,
    DELETE,
    MUSIC
}