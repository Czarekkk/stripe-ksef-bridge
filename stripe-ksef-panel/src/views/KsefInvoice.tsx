import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import KsefStatus from "./KsefStatus";

// Widok na stripe.dashboard.invoice.detail (komponent musi być unikalny per viewport).
const KsefInvoice = (props: ExtensionContextValue) => <KsefStatus {...props} />;

export default KsefInvoice;
