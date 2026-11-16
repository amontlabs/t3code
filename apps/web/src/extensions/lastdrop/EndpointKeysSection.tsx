/**
 * The Z.ai and OpenRouter keys, kept in the keychain by the server. On lastdrop's own Z.ai or OpenRouter card:
 * that provider's key. On the main Claude card, below its accounts: both, which is also where the first key is
 * added (there's no Z.ai or OpenRouter card until a key exists), with "Import from the lastdrop app".
 */
import { useState } from "react";

import { SettingsSection } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import type { ExtensionInstanceSectionProps } from "../index";
import {
  type EndpointProviderId,
  type KeyPlace,
  type KeyStatusView,
  useEndpointKeys,
} from "./endpointKeysRoute";

const PLACES: Readonly<
  Record<KeyPlace, { readonly text: string; readonly variant: "success" | "secondary" | "warning" }>
> = {
  own: { text: "Key saved", variant: "success" },
  other: { text: "Key from the environment or Z.ai's key file", variant: "secondary" },
  none: { text: "No key", variant: "secondary" },
  unreadable: { text: "Keychain unavailable", variant: "warning" },
};

function KeyRow(props: {
  readonly status: KeyStatusView;
  readonly readOnly: boolean;
  readonly save: (provider: EndpointProviderId, key: string) => Promise<string | undefined>;
  readonly clear: (provider: EndpointProviderId) => Promise<string | undefined>;
}) {
  const { status, readOnly, save, clear } = props;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const place = PLACES[status.place];
  const run = async (action: () => Promise<string | undefined>, done?: () => void) => {
    setBusy(true);
    const failure = await action();
    setBusy(false);
    setError(failure);
    if (failure === undefined) done?.();
  };
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{status.title}</span>
        <Badge variant={place.variant}>{place.text}</Badge>
      </div>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () => save(status.provider, draft),
            () => setDraft(""),
          );
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            aria-label={`${status.title} API key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              status.place === "own" ? "Paste a new key to replace it" : "Paste the API key"
            }
            value={draft}
            maxLength={4096}
            disabled={busy || readOnly}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <Button variant="outline" type="submit" disabled={busy || readOnly || draft.trim() === ""}>
          Save
        </Button>
        {status.place === "own" ? (
          <Button
            variant="ghost-destructive"
            type="button"
            disabled={busy || readOnly}
            onClick={() => void run(() => clear(status.provider))}
          >
            Clear
          </Button>
        ) : null}
      </form>
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </li>
  );
}

/** The keys of `only` (one provider's card), or of both providers (the main Claude card). */
export function EndpointKeysSection(
  props: ExtensionInstanceSectionProps & { readonly only?: EndpointProviderId },
) {
  const { environmentId, readOnly, only } = props;
  const { load, change } = useEndpointKeys(environmentId);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | undefined>();
  const rows =
    load.state === "loaded"
      ? load.keys.filter((k) => only === undefined || k.provider === only)
      : [];
  const importable =
    load.state === "loaded" ? load.importable.filter((p) => only === undefined || p === only) : [];
  return (
    <SettingsSection title={only === undefined ? "Z.ai and OpenRouter keys" : "API key"}>
      <div className="text-sm">
        {load.state !== "loaded" ? (
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
            {load.state === "loading" ? "Reading keys…" : load.message}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((status) => (
              <KeyRow
                key={status.provider}
                status={status}
                readOnly={readOnly}
                save={(provider, key) => change({ method: "PUT", provider, key })}
                clear={(provider) => change({ method: "DELETE", provider })}
              />
            ))}
            {importable.length > 0 ? (
              <li className="flex flex-col gap-2 px-3 py-3 sm:px-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    disabled={importing || readOnly}
                    onClick={() => {
                      setImporting(true);
                      void change({ method: "POST" }).then((failure) => {
                        setImporting(false);
                        setImportError(failure);
                      });
                    }}
                  >
                    Import from the lastdrop app
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Copies the key once. The app is not changed.
                  </span>
                </div>
                {importError ? (
                  <p className="text-xs text-destructive-foreground">{importError}</p>
                ) : null}
              </li>
            ) : null}
            {only === undefined ? (
              <li className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
                A key adds a Z.ai or OpenRouter provider, within a minute. Keys stay in the macOS
                keychain.
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
