import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import { copyText } from "@/lib/copy-text";

import { addConnectorRedirect, disconnectApps, removeConnectorRedirect, setConnector } from "./actions";
import { ConnectorSection } from "./connector-section";

vi.mock("./actions", () => ({
  setConnector: vi.fn(async ({ on }: { on: boolean }) => ({ ok: true, data: { on } })),
  disconnectApps: vi.fn(async () => ({ ok: true, data: null, toast: "Every app is disconnected." })),
  addConnectorRedirect: vi.fn(async ({ uri }: { uri: string }) => ({ ok: true, data: { redirects: [uri] } })),
  removeConnectorRedirect: vi.fn(async () => ({ ok: true, data: { redirects: [] } })),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));
vi.mock("@/lib/copy-text", () => ({ copyText: vi.fn(async () => true) }));

const ADDRESS = "https://dossier.example/api/mcp";

beforeEach(() => vi.clearAllMocks());

describe("Settings → MCP connector (#221, #281)", () => {
  it("is off until it's turned on, and then shows the address to add in an app", async () => {
    const user = userEvent.setup();
    render(<ConnectorSection initial={{ on: false, redirects: [] }} address={ADDRESS} />);
    expect(screen.getByRole("heading", { name: "MCP connector" })).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Let apps connect" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("Off. The connector's addresses aren't open on this server.");
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument();

    await user.click(toggle);
    expect(setConnector).toHaveBeenCalledWith({ on: true });
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByText(/claude mcp add --transport http dossier https:\/\/dossier\.example\/api\/mcp/)).toBeInTheDocument();
    // A public HTTPS address needs no warning.
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenCalledWith(ADDRESS);
    expect(toast).toHaveBeenCalledWith("Address copied.");
  });

  it("shows the home-network address too when the page was opened on one, with a Copy of its own", async () => {
    const user = userEvent.setup();
    const lan = "http://192.168.1.20:3000/api/mcp";
    render(<ConnectorSection initial={{ on: true, redirects: [] }} address={ADDRESS} lanAddress={lan} />);
    expect(screen.getByText("On your home network")).toBeInTheDocument();
    expect(screen.getByText(lan)).toBeInTheDocument();
    // The public address stays the one in the steps and the command.
    expect(screen.getByText(/claude mcp add --transport http dossier https:\/\/dossier\.example\/api\/mcp/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy the home network address" }));
    expect(copyText).toHaveBeenCalledWith(lan);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenLastCalledWith(ADDRESS);
  });

  it("shows one address when there's no home-network one, or it's the same", () => {
    const { rerender } = render(<ConnectorSection initial={{ on: true, redirects: [] }} address={ADDRESS} />);
    expect(screen.queryByText("On your home network")).not.toBeInTheDocument();
    rerender(<ConnectorSection initial={{ on: true, redirects: [] }} address={ADDRESS} lanAddress={ADDRESS} />);
    expect(screen.queryByText("On your home network")).not.toBeInTheDocument();
  });

  it("turns it off again, and puts the switch back when that fails", async () => {
    const user = userEvent.setup();
    render(<ConnectorSection initial={{ on: true, redirects: [] }} address={ADDRESS} />);
    vi.mocked(setConnector).mockResolvedValueOnce({ ok: false, error: "Something went wrong on the server. Please try again." });
    await user.click(screen.getByRole("switch", { name: "Let apps connect" }));
    expect(setConnector).toHaveBeenCalledWith({ on: false });
    expect(screen.getByRole("switch", { name: "Let apps connect" })).toHaveAttribute("aria-checked", "true");
  });

  it("says Claude on the web and cloud apps need a public HTTPS address, which a local one isn't", () => {
    render(<ConnectorSection initial={{ on: true, redirects: [] }} address="http://localhost:3000/api/mcp" />);
    expect(screen.getByRole("note")).toHaveTextContent(/This is a local address\. Claude on the web, Desktop and mobile, and apps in the cloud such as n8n Cloud, reach Dossier from their own servers/);
  });

  it("adds and removes other apps' callback addresses", async () => {
    const user = userEvent.setup();
    const n8n = "https://n8n.example/rest/oauth2-credential/callback";
    render(<ConnectorSection initial={{ on: true, redirects: [] }} address={ADDRESS} />);
    await user.type(screen.getByLabelText("Callback address"), `${n8n}{Enter}`);
    expect(addConnectorRedirect).toHaveBeenCalledWith({ uri: n8n });
    expect(screen.getByRole("list", { name: "Apps' callback addresses" })).toHaveTextContent(n8n);
    expect(screen.getByLabelText("Callback address")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: `Remove ${n8n}` }));
    expect(removeConnectorRedirect).toHaveBeenCalledWith({ uri: n8n });
    expect(screen.queryByRole("list", { name: "Apps' callback addresses" })).not.toBeInTheDocument();
  });

  it("disconnects every app", async () => {
    const user = userEvent.setup();
    render(<ConnectorSection initial={{ on: true, redirects: [] }} address={ADDRESS} />);
    await user.click(screen.getByRole("button", { name: "Disconnect all apps" }));
    expect(disconnectApps).toHaveBeenCalledWith({});
  });
});
