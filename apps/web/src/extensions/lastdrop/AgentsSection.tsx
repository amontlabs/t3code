/**
 * lastdrop's agents, on the "lastdrop agents" provider's card: each agent's name, description, provider and
 * model, effort and fallbacks in order, with a switch. Add, edit, remove; the list lives on the server in
 * `~/.t3/lastdrop/agents.json` (`/api/lastdrop/agents`).
 */
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { SettingsSection } from "~/components/settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";

import type { ExtensionInstanceSectionProps } from "../index";
import { useAgentsEditor, type AgentsWrite } from "./agentsApi";
import {
  EFFORT_LABEL,
  MAX_FALLBACKS,
  blankAgent,
  blankEntry,
  changeEntry,
  draftProblem,
  effortChoices,
  entryLabel,
  moveItem,
  providerLabel,
  withAgent,
  withEffort,
  withEnabled,
  withFirstEntry,
  withoutAgent,
  type AgentEntry,
  type AgentProvider,
  type AgentRecord,
  type ProviderChoice,
} from "./agentsView";

/** The select value for "the run's own effort". */
const RUN_EFFORT = "run";

function EntryFields(props: {
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly entry: AgentEntry;
  readonly disabled: boolean;
  readonly onChange: (entry: AgentEntry) => void;
  readonly label: string;
}) {
  const { providers, entry, disabled, onChange, label } = props;
  const listId = useId();
  const choice = providers.find((candidate) => candidate.provider === entry.provider);
  const efforts = effortChoices(providers, entry);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={entry.provider}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === "string") {
            onChange(changeEntry(providers, entry, { provider: next as AgentProvider }));
          }
        }}
      >
        <SelectTrigger size="sm" className="w-36 shrink-0" aria-label={`${label}: provider`}>
          <SelectValue>{providerLabel(providers, entry.provider)}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {providers.map((option) => (
            <SelectItem hideIndicator key={option.provider} value={option.provider}>
              {option.label}
              {option.available ? "" : " (not set up)"}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <div className="min-w-40 flex-1">
        <Input
          size="sm"
          list={listId}
          value={entry.model}
          disabled={disabled}
          placeholder="Model"
          aria-label={`${label}: model`}
          onChange={(event) =>
            onChange(changeEntry(providers, entry, { model: event.target.value }))
          }
        />
        <datalist id={listId}>
          {(choice?.models ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </datalist>
      </div>
      {efforts.length > 0 ? (
        <Select
          value={entry.effort ?? RUN_EFFORT}
          disabled={disabled}
          onValueChange={(next) => {
            if (typeof next === "string") {
              onChange(withEffort(entry, next === RUN_EFFORT ? undefined : next));
            }
          }}
        >
          <SelectTrigger size="sm" className="w-32 shrink-0" aria-label={`${label}: effort`}>
            <SelectValue>
              {entry.effort === undefined ? "Auto" : (EFFORT_LABEL[entry.effort] ?? entry.effort)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem
              hideIndicator
              value={RUN_EFFORT}
              title="The caller picks the effort when it starts the agent"
            >
              Auto
            </SelectItem>
            {efforts.map((level) => (
              <SelectItem hideIndicator key={level} value={level}>
                {EFFORT_LABEL[level] ?? level}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </div>
  );
}

function AgentDialog(props: {
  readonly initial: AgentRecord;
  readonly agents: ReadonlyArray<AgentRecord>;
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (draft: AgentRecord) => Promise<AgentsWrite>;
}) {
  const { initial, agents, providers, busy } = props;
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const others = agents.filter((agent) => agent.id !== initial.id);
  const problem = draftProblem(draft, others);
  const isNew = initial.id === "";
  const setFallbacks = (fallbacks: ReadonlyArray<AgentEntry>) =>
    setDraft((current) => ({ ...current, fallbacks }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (problem !== undefined || busy) return;
            setError(undefined);
            void props.onSave(draft).then((result) => {
              if (result.ok) props.onClose();
              else setError(result.message);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{isNew ? "Add agent" : `Edit ${initial.name}`}</DialogTitle>
            <DialogDescription>
              A thread on this agent runs on its first entry. When that provider is out of room or
              fails to open, lastdrop moves on to the next entry, in order.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1.5 text-sm">
              <span>Name</span>
              <Input
                autoFocus
                value={draft.name}
                disabled={busy}
                placeholder="build"
                onChange={(event) => {
                  const name = event.target.value;
                  setDraft((current) => ({ ...current, name }));
                }}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>Description</span>
              <Textarea
                rows={2}
                value={draft.description}
                disabled={busy}
                placeholder="What this agent is for. The calling agent reads it to choose."
                onChange={(event) => {
                  const description = event.target.value;
                  setDraft((current) => ({ ...current, description }));
                }}
              />
            </label>
            <div className="space-y-2 text-sm">
              <span>Runs on</span>
              <EntryFields
                providers={providers}
                entry={draft}
                disabled={busy}
                label="First entry"
                onChange={(entry) => setDraft((current) => withFirstEntry(current, entry))}
              />
            </div>
            <div className="space-y-2 text-sm">
              <span>Then, when it has no room</span>
              {draft.fallbacks.length === 0 ? (
                <p className="text-xs text-muted-foreground">No fallbacks.</p>
              ) : null}
              <ol className="space-y-2">
                {draft.fallbacks.map((entry, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- Entries have no id; the list is edited in place.
                  <li key={index} className="flex items-start gap-1">
                    <span className="w-4 pt-1.5 text-xs text-muted-foreground tabular-nums">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <EntryFields
                        providers={providers}
                        entry={entry}
                        disabled={busy}
                        label={`Fallback ${index + 1}`}
                        onChange={(next) =>
                          setFallbacks(
                            draft.fallbacks.map((old, at) => (at === index ? next : old)),
                          )
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={`Move fallback ${index + 1} up`}
                      disabled={busy || index === 0}
                      onClick={() => setFallbacks(moveItem(draft.fallbacks, index, index - 1))}
                    >
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={`Move fallback ${index + 1} down`}
                      disabled={busy || index === draft.fallbacks.length - 1}
                      onClick={() => setFallbacks(moveItem(draft.fallbacks, index, index + 1))}
                    >
                      <ArrowDownIcon />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost-destructive"
                      aria-label={`Remove fallback ${index + 1}`}
                      disabled={busy}
                      onClick={() => setFallbacks(draft.fallbacks.filter((_, at) => at !== index))}
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ol>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy || draft.fallbacks.length >= MAX_FALLBACKS}
                onClick={() =>
                  setFallbacks([
                    ...draft.fallbacks,
                    blankEntry(
                      providers.find((p) => p.provider !== draft.provider)?.provider ?? "claude",
                    ),
                  ])
                }
              >
                <PlusIcon /> Add fallback
              </Button>
            </div>
            {draft.name !== "" && problem !== undefined ? (
              <p className="text-xs text-muted-foreground">{problem}</p>
            ) : null}
            {error !== undefined ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || problem !== undefined}>
              {busy ? <Spinner size="xs" /> : null} {isNew ? "Add agent" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function AgentRow(props: {
  readonly agent: AgentRecord;
  readonly providers: ReadonlyArray<ProviderChoice>;
  readonly locked: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const { agent, providers, locked } = props;
  return (
    <li className="flex flex-col gap-1.5 px-3 py-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{agent.name}</span>
        <Badge variant="secondary">{entryLabel(providers, agent)}</Badge>
        <span className="flex-1" />
        <Switch
          size="sm"
          checked={agent.enabled}
          disabled={locked}
          aria-label={`${agent.name} enabled`}
          onCheckedChange={props.onToggle}
        />
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={`Edit ${agent.name}`}
          disabled={locked}
          onClick={props.onEdit}
        >
          <PencilIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost-destructive"
          aria-label={`Remove ${agent.name}`}
          disabled={locked}
          onClick={props.onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      {agent.description !== "" ? (
        <p className="text-xs text-muted-foreground">{agent.description}</p>
      ) : null}
      {agent.fallbacks.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Then {agent.fallbacks.map((entry) => entryLabel(providers, entry)).join(", then ")}
        </p>
      ) : null}
    </li>
  );
}

export function AgentsSection(props: ExtensionInstanceSectionProps) {
  const { load, busy, save, importFromApp } = useAgentsEditor(props.environmentId);
  const [editing, setEditing] = useState<AgentRecord | undefined>();
  const [removing, setRemoving] = useState<AgentRecord | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const view = load.state === "loaded" ? load.view : undefined;
  const locked = props.readOnly || busy || view?.problem !== undefined;
  const run = async (write: Promise<AgentsWrite>) => {
    setNotice(undefined);
    const result = await write;
    if (!result.ok) setNotice(result.message);
    return result;
  };
  return (
    <SettingsSection
      title="Agents"
      headerAction={
        view === undefined ? undefined : (
          <div className="flex items-center gap-2">
            {view.canImport ? (
              <Button
                size="xs"
                variant="outline"
                disabled={locked}
                onClick={() => void run(importFromApp())}
              >
                Import from the lastdrop app
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={locked}
              onClick={() => setEditing(blankAgent(view.providers))}
            >
              <PlusIcon /> Add agent
            </Button>
          </div>
        )
      }
    >
      <div className="text-sm">
        {view === undefined ? (
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
            {load.state === "failed" ? load.message : "Reading agents…"}
          </p>
        ) : (
          <>
            {view.problem !== undefined ? (
              <p className="px-3 py-3 text-xs text-destructive sm:px-4">{view.problem}</p>
            ) : null}
            {notice !== undefined ? (
              <p className="px-3 py-3 text-xs text-destructive sm:px-4">{notice}</p>
            ) : null}
            {view.agents.length === 0 && view.problem === undefined ? (
              <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
                {view.canImport
                  ? "No agents yet. Import the ones from the lastdrop app, or add one."
                  : "No agents yet. Add one: a thread picks it as a model, and Claude Code agents can call it."}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {view.agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    providers={view.providers}
                    locked={locked}
                    onToggle={(enabled) =>
                      void run(save(withEnabled(view.agents, agent.id, enabled)))
                    }
                    onEdit={() => setEditing(agent)}
                    onRemove={() => setRemoving(agent)}
                  />
                ))}
              </ul>
            )}
            {editing !== undefined ? (
              <AgentDialog
                key={editing.id}
                initial={editing}
                agents={view.agents}
                providers={view.providers}
                busy={busy}
                onClose={() => setEditing(undefined)}
                onSave={(draft) => save(withAgent(view.agents, draft))}
              />
            ) : null}
            <AlertDialog
              open={removing !== undefined}
              onOpenChange={(open) => {
                if (!open && !busy) setRemoving(undefined);
              }}
            >
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Threads already on this agent keep their history, but new ones can't pick it.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() => {
                      if (removing === undefined) return;
                      void run(save(withoutAgent(view.agents, removing.id))).then((result) => {
                        if (result.ok) setRemoving(undefined);
                      });
                    }}
                  >
                    {busy ? <Spinner size="xs" /> : null} Remove
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
