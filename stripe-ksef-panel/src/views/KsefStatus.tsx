import { useEffect, useState } from "react";
import { Badge, Banner, Box, ContextView, Inline, Link, List, ListItem, Spinner } from "@stripe/ui-extension-sdk/ui";
import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
// URL mostu — ustaw w src/bridge.ts (musi zgadzać się z connect-src w stripe-app.json).
import { BRIDGE_URL as BACKEND } from "../bridge";

interface KsefStatusData {
  found: boolean;
  status?: string;
  ksefNumber?: string | null;
  fvNumber?: string;
  buyerName?: string | null;
  sentAt?: string | null;
  grossGrosze?: number | null;
  currency?: string | null;
  verifyUrl?: string | null;
  error?: string | null;
  hasUpo?: boolean;
  hasXml?: boolean;
}

type BadgeType = "neutral" | "warning" | "negative" | "positive";

function badgeFor(status?: string): { type: BadgeType; label: string } {
  switch (status) {
    case "accepted":
      return { type: "positive", label: "Wystawiona w KSeF" };
    case "rejected":
      return { type: "negative", label: "Odrzucona przez KSeF" };
    case "error":
      return { type: "negative", label: "Błąd wystawienia" };
    case "sent":
    case "pending":
      return { type: "warning", label: "Wysyłanie do KSeF…" };
    case "manual":
      return { type: "warning", label: "Do ręcznego wystawienia" };
    default:
      return { type: "neutral", label: status ?? "—" };
  }
}

function money(grosze?: number | null, currency?: string | null): string {
  if (grosze == null) return "—";
  return `${(grosze / 100).toFixed(2)} ${currency ?? "PLN"}`;
}

const KsefStatus = ({ environment }: ExtensionContextValue) => {
  const id = environment.objectContext?.id ?? null;
  const [data, setData] = useState<KsefStatusData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      fetch(`${BACKEND}/ksef/status/${id}`)
        .then((r) => r.json())
        .then((d: KsefStatusData) => {
          if (!active) return;
          setData(d);
          setLoading(false);
          // live: dopóki w toku, odświeżaj
          if (d.found && (d.status === "sent" || d.status === "pending")) {
            timer = setTimeout(tick, 3000);
          }
        })
        .catch(() => {
          if (active) {
            setData({ found: false });
            setLoading(false);
          }
        });
    };
    tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  const inProgress = data?.status === "sent" || data?.status === "pending";
  const isManual = data?.status === "manual";
  const badge = badgeFor(data?.status);

  return (
    <ContextView title="KSeF">
      {loading ? (
        <Spinner />
      ) : !data?.found ? (
        <Banner type="caution" description="Brak faktury KSeF dla tej płatności." />
      ) : isManual ? (
        <Box css={{ stack: "y", gap: "medium" }}>
          <Badge type={badge.type}>{badge.label}</Badge>
          <Banner
            type="caution"
            description={data.error ?? "Faktury nie wystawiono automatycznie — wymaga ręcznego wystawienia."}
          />
          <List>
            <ListItem title="Nabywca" value={data.buyerName ?? "—"} />
            <ListItem title="Kwota" value={money(data.grossGrosze, data.currency)} />
          </List>
        </Box>
      ) : (
        <Box css={{ stack: "y", gap: "medium" }}>
          <Box css={{ stack: "x", gap: "small", alignY: "center" }}>
            <Badge type={badge.type}>{badge.label}</Badge>
            {inProgress ? <Spinner size="small" /> : null}
          </Box>
          <List>
            <ListItem title="Numer faktury" value={data.fvNumber ?? "—"} />
            <ListItem title="Numer KSeF" value={data.ksefNumber ?? "—"} />
            {data.sentAt ? (
              <ListItem title="Wysłano" value={new Date(data.sentAt).toLocaleString("pl-PL")} />
            ) : null}
          </List>
          {data.verifyUrl ? (
            <Link external href={data.verifyUrl} target="_blank" type="primary">
              Otwórz / pobierz w KSeF
            </Link>
          ) : null}
          {data.hasUpo ? (
            <Link external href={`${BACKEND}/ksef/upo/${id}`} target="_blank">
              Pobierz UPO
            </Link>
          ) : null}
          {data.hasXml ? (
            <Link external href={`${BACKEND}/ksef/xml/${id}`} target="_blank">
              Pobierz XML FA(3)
            </Link>
          ) : null}
          {data.error ? <Banner type="critical" description={data.error} /> : null}
          {inProgress ? <Inline css={{ color: "secondary", font: "caption" }}>Status odświeża się automatycznie…</Inline> : null}
        </Box>
      )}
    </ContextView>
  );
};

export default KsefStatus;
