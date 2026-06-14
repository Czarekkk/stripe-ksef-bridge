import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import KsefStatus from "./KsefStatus";

// Widok na stripe.dashboard.payment.detail (komponent musi być unikalny per viewport).
const KsefPayment = (props: ExtensionContextValue) => <KsefStatus {...props} />;

export default KsefPayment;
