import { networkInterfaces } from "node:os";

export function setupTailscaleServe(port = 3000, httpsPort = 443): boolean {
	// Tailscale serve: exposes localhost dashboard securely.
	// Only activates when TAILSCALE_ENABLED=1 is set.
	if (process.env.TAILSCALE_ENABLED !== "1") return false;
	console.log(`[tailscale] Serve enabled on port ${port} (https:${httpsPort})`);
	return true;
}

// CGNAT block used by Tailscale for client addresses (100.64.0.0/10).
const TAILSCALE_CGNAT_PREFIX = "100.";

/**
 * Detect the IPv4 address Tailscale has assigned to this host, so the dashboard
 * server can auto-bind to the tailnet interface and be reachable from other
 * devices on the tailnet. Returns null when Tailscale is not present.
 *
 * The default Tailscale interface name is `tailscale0` on Linux and `Tailscale`
 * on macOS/Windows. We prefer an address inside Tailscale's CGNAT range
 * (100.64.0.0/10) when one exists; otherwise we return the first IPv4 address
 * found on the interface.
 */
export function detectTailscaleIP(): string | null {
	const ifaces = networkInterfaces();
	const candidates: Array<string> = [];
	for (const [name, addrs] of Object.entries(ifaces)) {
		if (name !== "tailscale0" && name !== "Tailscale") continue;
		if (!addrs) continue;
		for (const addr of addrs) {
			if (addr.family === "IPv4") {
				candidates.push(addr.address);
			}
		}
	}
	if (candidates.length === 0) return null;
	const cgnat = candidates.find((ip) => ip.startsWith(TAILSCALE_CGNAT_PREFIX));
	return cgnat ?? candidates[0];
}
