export interface ProfileHookEvent {
    name: string;
    ts?: number;
    dur?: number;
    data?: Record<string, string | number | boolean | null>;
}
export declare function profileEvent(name: string, data?: Record<string, string | number | boolean | null>): void;
export declare function profileStart(): number | null;
export declare function profileDuration(name: string, start: number | null, data?: Record<string, string | number | boolean | null>): void;
//# sourceMappingURL=profile.d.ts.map