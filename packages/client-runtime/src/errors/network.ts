import { BRAND } from "@t3tools/shared/branding";
// A failed request cannot distinguish filtering from an outage. Keep this a
// possible cause, and suggest a way to check without changing server settings.
export const NETWORK_BLOCKING_HINT = `Your DNS or firewall may be blocking ${BRAND.connectName}. Try another network, such as a phone hotspot.`;
