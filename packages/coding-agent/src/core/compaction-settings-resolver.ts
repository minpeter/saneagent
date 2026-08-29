import type { CompactionSettings } from "./compaction-settings-access.ts";

export interface ResolvedCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	speculativeEnabled: boolean;
	speculativeFraction: number;
	speculativeCooldownMs: number;
	restorationEnabled: boolean;
	restorationMaxItems: number;
	restorationMaxTokensPerItem: number;
	restorationMaxTotalTokens: number;
	restorationContextRatio: number;
	idleCompactionEnabled: boolean;
	graceBandEnabled: boolean;
	toolAdmissionEnabled: boolean;
	reminderEnabled: boolean;
	reserveScalingEnabled: boolean;
	speculativeLeadTokens?: number;
}

export function resolveCompactionSettings(settings?: CompactionSettings): ResolvedCompactionSettings {
	return {
		enabled: settings?.enabled ?? true,
		reserveTokens: settings?.reserveTokens ?? 16384,
		keepRecentTokens: settings?.keepRecentTokens ?? 20000,
		speculativeEnabled: settings?.speculativeEnabled ?? true,
		speculativeFraction: settings?.speculativeFraction ?? 0.75,
		speculativeCooldownMs: settings?.speculativeCooldownMs ?? 30000,
		restorationEnabled: settings?.restorationEnabled ?? true,
		restorationMaxItems: settings?.restorationMaxItems ?? 10,
		restorationMaxTokensPerItem: settings?.restorationMaxTokensPerItem ?? 5000,
		restorationMaxTotalTokens: settings?.restorationMaxTotalTokens ?? 50_000,
		restorationContextRatio: settings?.restorationContextRatio ?? 0.15,
		idleCompactionEnabled: settings?.idleCompactionEnabled ?? true,
		graceBandEnabled: settings?.graceBandEnabled ?? true,
		toolAdmissionEnabled: settings?.toolAdmissionEnabled ?? true,
		reminderEnabled: settings?.reminderEnabled ?? true,
		reserveScalingEnabled: settings?.reserveScalingEnabled ?? true,
		speculativeLeadTokens: settings?.speculativeLeadTokens,
	};
}
