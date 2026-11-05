import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import {
  FREE,
  FREE_MESSAGE,
  GUM_BUTTON,
  GUM_KEY,
  LS_BUTTON,
  LS_KEY,
  STORES,
  TRIAL_ACTIVE,
  SUPPORT,
  apiError,
  keyInput,
  lsActive,
  paste,
  renderSection,
  status,
} from "./licenseFixtures";

vi.mock("../../../services/licenseService", () => ({
  licenseService: {
    get: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
    remove: vi.fn(),
  },
}));
import { licenseService } from "../../../services/licenseService";

beforeEach(() => {
  licenseService.get.mockResolvedValue(FREE);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("LicenseSection free: activation form", () => {
  it("shows the free message, a labelled key input and no file upload", async () => {
    renderSection();
    expect(await screen.findByTestId("license-state")).toHaveTextContent(
      "Free",
    );
    expect(screen.getByText(FREE_MESSAGE)).toBeInTheDocument();
    const box = await keyInput();
    expect(box).toHaveAttribute("autocomplete", "off");
    expect(box).toHaveAttribute("spellcheck", "false");
    expect(box).toHaveClass("glass-input");
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(
      screen.queryByRole("button", { name: /install/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/\.burrowlicense|license file/i),
    ).not.toBeInTheDocument();
  });

  it("defaults the picker to Gumroad, with Gumroad first", async () => {
    renderSection();
    await keyInput();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.value)).toEqual(["gumroad", "lemonsqueezy"]);
    expect(radios[0]).toBeChecked();
    expect(
      screen.getByRole("button", { name: GUM_BUTTON }),
    ).toBeInTheDocument();
  });

  it("hides the picker when one configured store is left (Gumroad only)", async () => {
    licenseService.get.mockResolvedValue(
      status({
        ...FREE,
        stores: [
          { id: "gumroad", label: "Gumroad", configured: true },
          { id: "lemonsqueezy", label: "Lemon Squeezy", configured: false },
        ],
      }),
    );
    renderSection();
    await keyInput();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: GUM_BUTTON }),
    ).toBeInTheDocument();
  });

  it("offers only Lemon Squeezy when Gumroad is not configured", async () => {
    licenseService.get.mockResolvedValue(
      status({
        ...FREE,
        stores: [
          { id: "gumroad", label: "Gumroad", configured: false },
          { id: "lemonsqueezy", label: "Lemon Squeezy", configured: true },
        ],
      }),
    );
    renderSection();
    await keyInput();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("button", { name: LS_BUTTON })).toBeInTheDocument();
  });

  it("shows the exact disclosure copy for each store", async () => {
    const user = userEvent.setup();
    renderSection();
    await keyInput();
    expect(
      screen.getByText(
        "Burrow sends your license key, Burrow's product id and a request to count one activation to Gumroad (api.gumroad.com). Gumroad also sees your IP address, like any website. Student and nonprofit keys may need a second check with Gumroad. Burrow contacts your store only when you activate or move your license, and never otherwise.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Lemon Squeezy" }));
    expect(
      screen.getByText(
        'Burrow sends your license key and the name "Burrow" for this computer to Lemon Squeezy (api.lemonsqueezy.com). Lemon Squeezy also sees your IP address, like any website. Burrow contacts your store only when you activate or move your license, and never otherwise.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: LS_BUTTON })).toBeInTheDocument();
  });

  it("ties the disclosure note to the input", async () => {
    renderSection();
    const box = await keyInput();
    const note = screen.getByText(/Burrow sends your license key/);
    expect(box.getAttribute("aria-describedby")).toContain(note.id);
  });

  it("switches the picker when the key fully matches the other store, and not before", async () => {
    const user = userEvent.setup();
    renderSection();
    const box = await keyInput();
    await user.type(box, LS_KEY.slice(0, 20));
    expect(screen.getByRole("radio", { name: "Gumroad" })).toBeChecked();
    await user.type(box, LS_KEY.slice(20));
    expect(screen.getByRole("radio", { name: "Lemon Squeezy" })).toBeChecked();
    expect(screen.getByRole("button", { name: LS_BUTTON })).toBeInTheDocument();
  });

  it("switches back to Gumroad for a pasted Gumroad key", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole("radio", { name: "Lemon Squeezy" }),
    );
    await paste(user, GUM_KEY);
    expect(screen.getByRole("radio", { name: "Gumroad" })).toBeChecked();
  });

  it("respects a manual pick made after the auto-switch", async () => {
    const user = userEvent.setup();
    renderSection();
    const box = await paste(user, LS_KEY);
    expect(screen.getByRole("radio", { name: "Lemon Squeezy" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Gumroad" }));
    await user.type(box, " ");
    expect(screen.getByRole("radio", { name: "Gumroad" })).toBeChecked();
  });

  it("disables Activate while the input is empty or blank", async () => {
    const user = userEvent.setup();
    renderSection();
    const button = await screen.findByRole("button", { name: GUM_BUTTON });
    expect(button).toBeDisabled();
    await user.type(await keyInput(), "   ");
    expect(button).toBeDisabled();
    await user.type(await keyInput(), "x");
    expect(button).toBeEnabled();
  });

  it("makes no activation call on render, typing, pasting or switching the store", async () => {
    const user = userEvent.setup();
    renderSection();
    await paste(user, GUM_KEY);
    await user.click(screen.getByRole("radio", { name: "Lemon Squeezy" }));
    await user.click(screen.getByRole("radio", { name: "Gumroad" }));
    await user.type(await keyInput(), "x");
    expect(licenseService.activate).not.toHaveBeenCalled();
    expect(licenseService.deactivate).not.toHaveBeenCalled();
    expect(licenseService.get).toHaveBeenCalledTimes(1);
  });
});

describe("LicenseSection activate", () => {
  it("activates a Gumroad key on click: trimmed key, picked store, toast, status refresh, focus", async () => {
    licenseService.activate.mockResolvedValue(status());
    const user = userEvent.setup();
    renderSection();
    const box = await paste(user, `  ${GUM_KEY}\n`);
    expect(licenseService.activate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: GUM_BUTTON }));
    await waitFor(() =>
      expect(licenseService.activate).toHaveBeenCalledWith({
        licenseKey: GUM_KEY,
        store: "gumroad",
      }),
    );
    expect(licenseService.activate).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("license-state")).toHaveTextContent("Pro"),
    );
    expect(screen.getAllByText("License activated.").length).toBeGreaterThan(0);
    expect(screen.getByTestId("license-state")).toHaveFocus();
    expect(box).not.toBeInTheDocument();
    expect(screen.getByText("Bought from Gumroad")).toBeInTheDocument();
  });

  it("sends the Lemon Squeezy store for an LS key", async () => {
    licenseService.activate.mockResolvedValue(lsActive());
    const user = userEvent.setup();
    renderSection();
    await paste(user, LS_KEY);
    await user.click(screen.getByRole("button", { name: LS_BUTTON }));
    await waitFor(() =>
      expect(licenseService.activate).toHaveBeenCalledWith({
        licenseKey: LS_KEY,
        store: "lemonsqueezy",
      }),
    );
  });

  it("submits with Enter in the key field", async () => {
    licenseService.activate.mockResolvedValue(status());
    const user = userEvent.setup();
    renderSection();
    await paste(user, GUM_KEY);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(licenseService.activate).toHaveBeenCalledTimes(1),
    );
  });

  it("shows Activating... with a disabled, aria-busy button while in flight and ignores a second click", async () => {
    let release;
    licenseService.activate.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const user = userEvent.setup();
    renderSection();
    await paste(user, GUM_KEY);
    await user.click(screen.getByRole("button", { name: GUM_BUTTON }));
    const busy = await screen.findByRole("button", { name: "Activating..." });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    await user.click(busy);
    expect(licenseService.activate).toHaveBeenCalledTimes(1);
    release(status());
    await waitFor(() =>
      expect(screen.getByTestId("license-state")).toHaveTextContent("Pro"),
    );
  });

  const SERVER_MESSAGES = [
    [
      "invalid_key_format",
      400,
      "That doesn't look like a Gumroad license key. Check that you picked the store you bought from, then paste the key from your receipt.",
    ],
    [
      "key_not_found",
      422,
      "Gumroad doesn't recognize this license key for Burrow. Check that you copied the whole key and picked the store you bought from, then click Activate again.",
    ],
    [
      "uses_exceeded",
      422,
      `This key has already been activated as many times as it allows. Email ${SUPPORT} and ask them to reset your activations, then click Activate again.`,
    ],
    [
      "purchase_refunded",
      422,
      `This purchase was refunded or disputed, so its key can't be activated. If you think that's a mistake, email ${SUPPORT}.`,
    ],
    [
      "test_purchase_not_allowed",
      422,
      "This is a test purchase key. Test keys only work in developer builds of Burrow. Use the key from your real purchase.",
    ],
    [
      "store_unreachable",
      503,
      "Burrow couldn't reach Gumroad. Check your internet connection, then click Activate again. Nothing was changed on this computer.",
    ],
    [
      "rate_limited",
      429,
      "Too many activation attempts. Wait 15 minutes, then try again.",
    ],
    [
      "activation_in_progress",
      409,
      "Burrow is already contacting the store. Wait for it to finish.",
    ],
    [
      "license_expired",
      422,
      "This license has already ended, so it can't turn Pro on. If you have a newer key, paste it here and click Activate.",
    ],
    [
      "activation_write_failed",
      500,
      "Burrow couldn't save your license on this computer. Check that the data folder can be written to, then click Activate again.",
    ],
  ];

  it.each(SERVER_MESSAGES)(
    "%s renders the server message in an alert, flags the input and focuses it",
    async (code, httpStatus, message) => {
      licenseService.activate.mockRejectedValue(
        apiError(code, message, httpStatus),
      );
      const user = userEvent.setup();
      renderSection();
      const box = await paste(user, GUM_KEY);
      await user.click(screen.getByRole("button", { name: GUM_BUTTON }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(box).toHaveAttribute("aria-invalid", "true");
      expect(box.getAttribute("aria-describedby")).toContain(alert.id);
      await waitFor(() => expect(box).toHaveFocus());
      expect(box).toHaveValue(GUM_KEY);
      expect(screen.getByRole("button", { name: GUM_BUTTON })).toBeEnabled();
      expect(screen.getByTestId("license-state")).toHaveTextContent("Free");
    },
  );

  it("uses one generic line when the server sends no message", async () => {
    licenseService.activate.mockRejectedValue(apiError("store_unreachable", ""));
    const user = userEvent.setup();
    renderSection();
    await paste(user, GUM_KEY);
    await user.click(screen.getByRole("button", { name: GUM_BUTTON }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong. Try again, or contact the seller.",
    );
  });

  it("shows generic copy, not the raw message, for a non-API failure", async () => {
    licenseService.activate.mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    renderSection();
    await paste(user, GUM_KEY);
    await user.click(screen.getByRole("button", { name: GUM_BUTTON }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong.");
    expect(alert).not.toHaveTextContent("Failed to fetch");
  });

  it("clears the error when the key changes", async () => {
    licenseService.activate.mockRejectedValue(
      apiError("key_not_found", "Nope."),
    );
    const user = userEvent.setup();
    renderSection();
    const box = await paste(user, GUM_KEY);
    await user.click(screen.getByRole("button", { name: GUM_BUTTON }));
    await screen.findByRole("alert");
    await user.type(box, "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(box).not.toHaveAttribute("aria-invalid");
  });

  it("the invalid state shows the server message and the activation form", async () => {
    licenseService.get.mockResolvedValue(
      status({
        ...FREE,
        state: "invalid",
        licenseState: "invalid",
        invalidReason: "tampered",
        message:
          "Burrow couldn't confirm the license saved on this computer, so Pro features are off. Your data is safe. Paste your license key below and click Activate to set it up again.",
      }),
    );
    renderSection();
    expect(await screen.findByTestId("license-state")).toHaveTextContent(
      "Invalid license",
    );
    expect(
      screen.getByText(/couldn't confirm the license saved on this computer/),
    ).toBeInTheDocument();
    expect(await keyInput()).toBeInTheDocument();
  });

  it("no store configured: shows the plain line, no form, and the trial still shows", async () => {
    licenseService.get.mockResolvedValue(
      status({
        ...FREE,
        stores: STORES.map((s) => ({ ...s, configured: false })),
      }),
    );
    renderSection();
    expect(
      await screen.findByText(
        "This version of Burrow can't activate licenses yet.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("License key")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Activate/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Try Pro free/ }),
    ).not.toBeInTheDocument();
  });

  it("treats a missing stores list as no store configured", async () => {
    licenseService.get.mockResolvedValue(
      status({ ...FREE, stores: undefined }),
    );
    renderSection();
    expect(
      await screen.findByText(
        "This version of Burrow can't activate licenses yet.",
      ),
    ).toBeInTheDocument();
  });

  it("states the network promise verbatim", async () => {
    renderSection();
    await screen.findByTestId("license-state");
    expect(
      screen.getAllByText(
        /Burrow contacts your store only when you activate or move your license, and never otherwise\./,
      ),
    ).toHaveLength(1);
  });

  describe("network promise appears exactly once in every state", () => {
    const PROMISE = /Burrow contacts your store only when you activate or move your license, and never otherwise\./;
    const once = async () => {
      await screen.findByTestId("license-state");
      expect(screen.getAllByText(PROMISE)).toHaveLength(1);
    };

    it("licensed: form closed, then open after Use a different key", async () => {
      licenseService.get.mockResolvedValue(lsActive());
      const user = userEvent.setup();
      renderSection();
      await once();
      expect(screen.queryByLabelText("License key")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Use a different key" }));
      await keyInput();
      await once();
    });

    it("expired", async () => {
      licenseService.get.mockResolvedValue(
        status({ state: "expired", licenseState: "expired", pro: false }),
      );
      renderSection();
      await keyInput();
      await once();
    });

    it("no store configured", async () => {
      licenseService.get.mockResolvedValue(
        status({ ...FREE, stores: STORES.map((s) => ({ ...s, configured: false })) }),
      );
      renderSection();
      await once();
    });

    it("trial", async () => {
      licenseService.get.mockResolvedValue(
        status({
          ...FREE,
          state: "trial",
          pro: true,
          proSource: "trial",
          trialDaysLeft: 5,
          trial: TRIAL_ACTIVE,
        }),
      );
      renderSection();
      await keyInput();
      await once();
    });
  });

  describe("Buy Burrow Pro and Activate a license stay visible", () => {
    it("on Free", async () => {
      renderSection();
      await keyInput();
      expect(screen.getByRole("heading", { name: "Activate a license" })).toBeVisible();
      expect(screen.getByRole("link", { name: /Buy Burrow Pro/ })).toBeVisible();
    });

    it("during the trial", async () => {
      licenseService.get.mockResolvedValue(
        status({
          ...FREE,
          state: "trial",
          pro: true,
          proSource: "trial",
          trialDaysLeft: 5,
          trial: TRIAL_ACTIVE,
        }),
      );
      renderSection();
      await keyInput();
      expect(screen.getByRole("heading", { name: "Activate a license" })).toBeVisible();
      expect(screen.getByRole("link", { name: /Buy Burrow Pro/ })).toBeVisible();
    });
  });

  it("load failure offers retry, disabled while retrying", async () => {
    licenseService.get.mockRejectedValueOnce(new Error("down"));
    const user = userEvent.setup();
    renderSection();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "load your license status",
    );
    let release;
    licenseService.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Retrying..." }),
    ).toBeDisabled();
    release(FREE);
    expect(await screen.findByTestId("license-state")).toHaveTextContent(
      "Free",
    );
  });
});
