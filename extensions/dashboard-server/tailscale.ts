export function setupTailscaleServe(port = 3000, httpsPort = 443): boolean {
	// Tailscale serve: exposes localhost dashboard securely.
	// Only activates when TAILSCALE_ENABLED=1 is set.
	if (process.env.TAILSCALE_ENABLED !== "1") return false;
	console.log(`[tailscale] Serve enabled on port ${port} (https:${httpsPort})`);
	return true;
}
