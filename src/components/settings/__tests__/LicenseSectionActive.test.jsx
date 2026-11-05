import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import {
  FALLBACK_SUPPORT,
  FREE,
  GUM_KEY,
  GUM_LICENSE,
  LS_BUTTON,
  LS_KEY,
  SUPPORT,
  TRIAL_ACTIVE,
  TRIAL_AVAILABLE,
  TRIAL_ENDED,
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
  licenseService.get.mockResolvedValue(status());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const MOVE = "Move to another computer";
const REMOVE = "Remove from this computer";

describe("LicenseSection active license", () => {
  it("gumroad pro: edition, store, dates, key tail, email and the support line", async () => {
    renderSection();
    expect(await screen.findByTestId("license-state")).toHaveTextContent("Pro");
    expect(screen.getByText("Standard")).toBeInTheDocument();
    expect(screen.getByText("Bought from Gumroad")).toBeInTheDocument();
    expect(screen.getByText("Purchase date").nextSibling).toHaveTextContent(
      "Sep 30, 2026",
    );
    expect(screen.getByText("Updates until").nextSibling).toHaveTextContent(
      "Sep 30, 2027",
    );
    expect(screen.getByText("Key ending in 3333")).toBeInTheDocument();
    expect(screen.getByText("sam@example.test")).toBeInTheDocument();
    expect(screen.queryByText("Ends")).not.toBeInTheDocument();
    expect(screen.queryByText("Test purchase")).not.toBeInTheDocument();
    expect(screen.queryByText("This version")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        `To use Burrow on a new computer beyond your limit, email ${SUPPORT} to reset your activations.`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: MOVE }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: REMOVE })).toBeInTheDocument();
    expect(screen.queryByLabelText("License key")).not.toBeInTheDocument();
  });

  it("gumroad support line falls back to the seller wording without a contact", async () => {
    licenseService.get.mockResolvedValue(status({ supportContact: null }));
    renderSection();
    await screen.findByTestId("license-state");
    expect(
      screen.getByText(
        `To use Burrow on a new computer beyond your limit, email ${FALLBACK_SUPPORT} to reset your activations.`,
      ),
    ).toBeInTheDocument();
  });

  it("omits the email row when the store sent none", async () => {
    licenseService.get.mockResolvedValue(
      status({ license: { ...GUM_LICENSE, email: null } }),
    );
    renderSection();
    await screen.findByTestId("license-state");
    expect(screen.queryByText("Email")).not.toBeInTheDocument();
  });

  it("family label", async () => {
    licenseService.get.mockResolvedValue(
      status({
        license: { ...GUM_LICENSE, edition: "family" },
        edition: "family",
      }),
    );
    renderSection();
    expect(
      await screen.findByText("Family (up to 5 people)"),
    ).toBeInTheDocument();
  });

  it("shows the Test purchase badge only for a test license", async () => {
    licenseService.get.mockResolvedValue(
      status({ license: { ...GUM_LICENSE, test: true } }),
    );
    renderSection();
    expect(await screen.findByText("Test purchase")).toHaveClass(
      "text-accent-blue",
    );
  });

  it("shows the Founding member pill only with the founder perk", async () => {
    licenseService.get.mockResolvedValue(
      status({
        edition: "founding",
        license: { ...GUM_LICENSE, edition: "founding" },
        perks: { founderBackground: true },
      }),
    );
    const first = renderSection();
    expect(await screen.findByText("Founding member")).toBeInTheDocument();
    first.unmount();
    licenseService.get.mockResolvedValue(status());
    renderSection();
    await screen.findByTestId("license-state");
    expect(screen.queryByText("Founding member")).not.toBeInTheDocument();
  });

  it("keeps the Founding pill when the update window passed", async () => {
    licenseService.get.mockResolvedValue(
      status({
        state: "update_window_passed",
        pro: false,
        license: { ...GUM_LICENSE, edition: "founding" },
        perks: { founderBackground: true },
      }),
    );
    renderSection();
    expect(await screen.findByText("Founding member")).toBeInTheDocument();
  });

  it("update_window_passed: the spec sentence with version, build date and updates-until", async () => {
    licenseService.get.mockResolvedValue(
      status({
        state: "update_window_passed",
        pro: false,
        build: {
          date: "2027-11-12T00:00:00Z",
          source: "bundled",
          version: "1.4.0",
        },
        license: { ...GUM_LICENSE, updatesUntil: "2027-10-05T00:00:00Z" },
      }),
    );
    renderSection();
    const sentence = await screen.findByText(
      /^This version \(1\.4\.0\) was released on /,
    );
    expect(sentence).toHaveTextContent(
      "This version (1.4.0) was released on Nov 12, 2027, after your updates ended on Oct 5, 2027. Pro is off in this version only; your data is untouched. Every Burrow version released on or before Oct 5, 2027 keeps Pro forever.",
    );
    expect(screen.getByTestId("license-state")).toHaveTextContent(
      "Update window passed",
    );
  });

  it("update_window_passed with no build date uses the shorter sentence; no updatesUntil falls back to the server message", async () => {
    licenseService.get.mockResolvedValue(
      status({
        state: "update_window_passed",
        pro: false,
        build: { date: null, source: "missing", version: "1.2.0" },
      }),
    );
    const first = renderSection();
    expect(
      await screen.findByText(
        /^This version \(1\.2\.0\) was released after your updates ended on /,
      ),
    ).toBeInTheDocument();
    first.unmount();
    licenseService.get.mockResolvedValue(
      status({
        state: "update_window_passed",
        pro: false,
        message: "Server says the window passed.",
        license: { ...GUM_LICENSE, updatesUntil: "" },
      }),
    );
    renderSection();
    expect(
      await screen.findByText("Server says the window passed."),
    ).toBeInTheDocument();
  });

  const yearly = (over = {}) =>
    status({
      edition: "student",
      license: {
        ...GUM_LICENSE,
        edition: "student",
        updatesUntil: "2027-09-30T14:02:11Z",
        expiresAt: "2027-09-30T14:02:11Z",
      },
      ...over,
    });

  it("yearly edition: Ends date and the get-a-new-key renewal line", async () => {
    licenseService.get.mockResolvedValue(yearly());
    renderSection();
    await screen.findByTestId("license-state");
    expect(screen.getByText("Student")).toBeInTheDocument();
    expect(screen.getByText("Ends").nextSibling).toHaveTextContent(
      "Sep 30, 2027",
    );
    expect(
      screen.getByText("Renews yearly: get a new key before Sep 30, 2027"),
    ).toBeInTheDocument();
  });

  it("expired yearly license: says how to turn Pro back on and opens the form", async () => {
    licenseService.get.mockResolvedValue(
      yearly({
        state: "expired",
        licenseState: "expired",
        pro: false,
        message: "Your license has ended, so Pro features are off.",
      }),
    );
    renderSection();
    expect(await screen.findByTestId("license-state")).toHaveTextContent(
      "Expired",
    );
    expect(
      screen.getByText("Get a new key to turn Pro back on."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Renews yearly/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Your license has ended, so Pro features are off/),
    ).toBeInTheDocument();
    expect(await keyInput()).toBeInTheDocument();
  });

  it("a standard license has no Ends or renewal row", async () => {
    renderSection();
    await screen.findByTestId("license-state");
    expect(screen.queryByText("Renewal")).not.toBeInTheDocument();
    expect(screen.queryByText("Ends")).not.toBeInTheDocument();
  });

  it("clock_issue: spec copy and no Check again button", async () => {
    licenseService.get.mockResolvedValue(
      status({
        state: "clock_issue",
        licenseState: "clock_issue",
        pro: false,
        message: "Burrow can't confirm your license yet. This clears on its own once the clock is right, and your data is safe.",
        clock: { rollbackDetected: true },
      }),
    );
    renderSection();
    expect(await screen.findByTestId("license-state")).toHaveTextContent(
      "Clock issue detected",
    );
    expect(
      screen.getByText(/can't confirm your license yet/),
    ).toHaveTextContent(
      "This clears on its own once the clock is right, and your data is safe.",
    );
    expect(
      screen.queryByRole("button", { name: "Check again" }),
    ).not.toBeInTheDocument();
  });

  it("never renders hash, instance, product or key material", async () => {
    licenseService.get.mockResolvedValue(
      status({
        license: {
          ...GUM_LICENSE,
          keyHash: "SECRETHASH",
          instanceId: "SECRETINSTANCE",
          productId: "SECRETPRODUCT",
        },
      }),
    );
    const { container } = renderSection();
    await screen.findByTestId("license-state");
    for (const secret of ["SECRETHASH", "SECRETINSTANCE", "SECRETPRODUCT"]) {
      expect(container).not.toHaveTextContent(secret);
    }
    expect(container).not.toHaveTextContent(GUM_KEY);
  });

  it("formats dates as the stored UTC day even when the local zone is behind UTC", async () => {
    const RealDtf = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      function (_locale, options) {
        return new RealDtf("en-US", options);
      },
    );
    licenseService.get.mockResolvedValue(
      status({
        license: { ...GUM_LICENSE, purchaseDate: "2026-10-05T00:30:00Z" },
      }),
    );
    renderSection();
    await screen.findByTestId("license-state");
    expect(screen.getByText("Purchase date").nextSibling).toHaveTextContent(
      /^Oct 5, 2026$/,
    );
  });

  it("Use a different key reveals the form with the replace hint, and activating replaces the license", async () => {
    licenseService.activate.mockResolvedValue(lsActive());
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole("button", { name: "Use a different key" }),
    );
    expect(
      screen.getByText(
        "Activating a different key replaces this one on this computer.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use a different key" }),
    ).not.toBeInTheDocument();
    await paste(user, LS_KEY);
    await user.click(screen.getByRole("button", { name: LS_BUTTON }));
    await waitFor(() =>
      expect(screen.getByText("Bought from Lemon Squeezy")).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("License key")).not.toBeInTheDocument();
  });
});

describe("LicenseSection move to another computer (Lemon Squeezy)", () => {
  beforeEach(() => {
    licenseService.get.mockResolvedValue(lsActive());
  });

  it("opens a confirm group with the spec copy and focuses Cancel; Cancel and Escape return focus", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: MOVE }));
    const group = screen.getByRole("group", {
      name: "Confirm moving your license",
    });
    expect(group).toHaveTextContent(
      "This frees this computer's activation at Lemon Squeezy so you can activate Burrow on another computer, and turns Pro off here. Burrow contacts Lemon Squeezy once.",
    );
    expect(
      within(group).getByRole("button", { name: "Move license" }),
    ).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(licenseService.deactivate).not.toHaveBeenCalled();
    await user.click(within(group).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: MOVE })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: MOVE }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: MOVE })).toHaveFocus();
    expect(licenseService.deactivate).not.toHaveBeenCalled();
  });

  it("releases the seat on Move license: toast, free state, focus on the title", async () => {
    licenseService.deactivate.mockResolvedValue(FREE);
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: MOVE }));
    await user.click(screen.getByRole("button", { name: "Move license" }));
    await waitFor(() =>
      expect(licenseService.deactivate).toHaveBeenCalledWith({}),
    );
    await waitFor(() =>
      expect(screen.getByTestId("license-state")).toHaveTextContent("Free"),
    );
    expect(
      screen.getAllByText(
        "License released. You can activate it on your other computer now.",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("license-state")).toHaveFocus();
  });

  it("license_key_needed shows a key input; the key is sent on the next Move license", async () => {
    licenseService.deactivate
      .mockRejectedValueOnce(
        apiError(
          "license_key_needed",
          "Burrow needs your license key to release this computer. Paste the key from your receipt, then click Move to another computer again.",
          409,
        ),
      )
      .mockResolvedValueOnce(FREE);
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: MOVE }));
    const group = screen.getByRole("group", {
      name: "Confirm moving your license",
    });
    expect(
      within(group).queryByLabelText("License key"),
    ).not.toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "Move license" }));
    expect(await within(group).findByRole("alert")).toHaveTextContent(
      "Burrow needs your license key",
    );
    const box = within(group).getByLabelText("License key");
    await waitFor(() => expect(box).toHaveFocus());
    expect(
      within(group).getByRole("button", { name: "Move license" }),
    ).toBeDisabled();
    await user.type(box, ` ${LS_KEY} `);
    await user.click(within(group).getByRole("button", { name: "Move license" }));
    await waitFor(() =>
      expect(licenseService.deactivate).toHaveBeenLastCalledWith({
        licenseKey: LS_KEY,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("license-state")).toHaveTextContent("Free"),
    );
  });

  it("key_mismatch keeps the key input open with the server message", async () => {
    licenseService.deactivate.mockRejectedValue(
      apiError(
        "key_mismatch",
        "That key doesn't match the license on this computer. Paste the same key you activated with.",
      ),
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: MOVE }));
    await user.click(screen.getByRole("button", { name: "Move license" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "doesn't match the license on this computer",
    );
    expect(screen.getByLabelText("License key")).toBeInTheDocument();
  });

  it("store_unreachable on move keeps the license and shows the message in the dialog", async () => {
    licenseService.deactivate.mockRejectedValue(
      apiError("store_unreachable", "", 503),
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: MOVE }));
    await user.click(screen.getByRole("button", { name: "Move license" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong. Try again, or contact the seller.",
    );
    expect(screen.getByTestId("license-state")).toHaveTextContent("Pro");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("shows no Gumroad support line", async () => {
    renderSection();
    await screen.findByTestId("license-state");
    expect(screen.queryByText(/beyond your limit/)).not.toBeInTheDocument();
  });
});

describe("LicenseSection remove from this computer", () => {
  it.each([
    [
      "gumroad",
      status(),
      "This removes the license from this computer only. Gumroad still counts this activation.",
    ],
    [
      "lemonsqueezy",
      lsActive(),
      "This removes the license from this computer only. Lemon Squeezy still counts this activation. To free the activation at Lemon Squeezy, use Move to another computer instead.",
    ],
  ])(
    "%s: confirm copy, then removes with a toast and moves focus to the title",
    async (_id, active, copy) => {
      licenseService.get.mockResolvedValue(active);
      licenseService.remove.mockResolvedValue(FREE);
      const user = userEvent.setup();
      renderSection();
      await user.click(await screen.findByRole("button", { name: REMOVE }));
      const group = screen.getByRole("group", {
        name: "Confirm license removal",
      });
      expect(group).toHaveTextContent(copy);
      expect(licenseService.remove).not.toHaveBeenCalled();
      expect(within(group).getByRole("button", { name: "Cancel" })).toHaveFocus();
      await user.click(within(group).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(licenseService.remove).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByTestId("license-state")).toHaveTextContent("Free"),
      );
      expect(
        screen.getAllByText("License removed from this computer.").length,
      ).toBeGreaterThan(0);
      expect(screen.getByTestId("license-state")).toHaveFocus();
    },
  );

  it("Cancel and Escape keep the license and return focus to the trigger", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: REMOVE }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: REMOVE })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: REMOVE }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: REMOVE })).toHaveFocus();
    expect(licenseService.remove).not.toHaveBeenCalled();
  });

  it("shows the server message when removal fails and keeps the license", async () => {
    licenseService.remove.mockRejectedValue(
      apiError(
        "activation_write_failed",
        "Burrow couldn't save your license on this computer.",
        500,
      ),
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: REMOVE }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn't save your license",
    );
    expect(screen.getByTestId("license-state")).toHaveTextContent("Pro");
  });

  it("shows generic copy when removal fails without an API error", async () => {
    licenseService.remove.mockRejectedValue(new Error("EPERM raw"));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: REMOVE }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Something went wrong. Try again, or contact the seller.",
    );
    expect(alert).not.toHaveTextContent("EPERM");
  });
});

describe("LicenseSection trial", () => {
  const freeWith = (trial, over = {}) => status({ ...FREE, trial, ...over });
  const activeTrial = (over = {}) =>
    status({
      state: "trial",
      edition: "trial",
      license: null,
      proSource: "local_trial",
      trial: TRIAL_ACTIVE,
      trialDaysLeft: 5,
      ...over,
    });

  it("never offers a button to start a trial", async () => {
    licenseService.get.mockResolvedValue(freeWith(TRIAL_AVAILABLE));
    renderSection();
    await screen.findByTestId("license-state");
    expect(
      screen.queryByRole("button", { name: /Try Pro free/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Starts now on this computer/),
    ).not.toBeInTheDocument();
  });

  it("renders nothing for the trial when no record exists yet", async () => {
    licenseService.get.mockResolvedValue(freeWith(TRIAL_AVAILABLE));
    renderSection();
    await screen.findByTestId("license-state");
    expect(
      screen.queryByText(/Your Pro trial ends on/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Your trial ended/)).not.toBeInTheDocument();
  });

  it("hides the trial block when a license gives Pro", async () => {
    licenseService.get.mockResolvedValue(
      status({ proSource: "license", trial: TRIAL_ACTIVE }),
    );
    renderSection();
    await screen.findByTestId("license-state");
    expect(
      screen.queryByText(/Your Pro trial ends on/),
    ).not.toBeInTheDocument();
  });

  it("an active trial shows the end date and the activation form stays available", async () => {
    licenseService.get.mockResolvedValue(activeTrial());
    renderSection();
    expect(await screen.findByTestId("license-state")).toHaveTextContent(
      "Trial: 5 days left",
    );
    expect(
      screen.getByText(
        "Your Pro trial ends on Oct 12, 2026. After that Burrow switches to Free and keeps all your data.",
      ),
    ).toBeInTheDocument();
    expect(await keyInput()).toBeInTheDocument();
  });

  it.each([
    [1, "Trial: 1 day left"],
    [0, "Trial: 0 days left"],
    [4.3, "Trial: 5 days left"],
  ])("trial days %s", async (days, title) => {
    licenseService.get.mockResolvedValue(activeTrial({ trialDaysLeft: days }));
    renderSection();
    expect(await screen.findByTestId("license-state")).toHaveTextContent(title);
    // The days left are said once (the title), not repeated in a body sentence.
    expect(screen.queryByText(/Your Pro trial is active/)).not.toBeInTheDocument();
  });

  it("ended trial explains that data is untouched and Pro is off", async () => {
    licenseService.get.mockResolvedValue(freeWith(TRIAL_ENDED));
    renderSection();
    expect(
      await screen.findByText("Your trial ended. Your data is all here."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pro features are off. Everything in Burrow Free keeps working.",
      ),
    ).toBeInTheDocument();
  });

  it("shows no ended-trial copy during a clock issue", async () => {
    licenseService.get.mockResolvedValue(
      freeWith(TRIAL_ENDED, { state: "clock_issue" }),
    );
    renderSection();
    await screen.findByTestId("license-state");
    expect(screen.queryByText(/Your trial ended/)).not.toBeInTheDocument();
  });
});

describe("LicenseSection copy", () => {
  it.each([
    ["free form", FREE],
    [
      "gumroad pro",
      status({
        perks: { founderBackground: true },
        license: { ...GUM_LICENSE, test: true },
      }),
    ],
    ["ls pro", lsActive()],
    [
      "update window passed",
      status({ state: "update_window_passed", pro: false }),
    ],
    [
      "expired yearly",
      status({
        state: "expired",
        licenseState: "expired",
        pro: false,
        license: {
          ...GUM_LICENSE,
          edition: "student",
          expiresAt: "2027-09-30T14:02:11Z",
        },
      }),
    ],
    ["no store", status({ ...FREE, stores: [] })],
  ])("rendered copy has no em dashes (%s)", async (_name, value) => {
    licenseService.get.mockResolvedValue(value);
    const { container } = renderSection();
    await screen.findByTestId("license-state");
    expect(container.textContent).not.toMatch(/—/);
  });

  it("an opened confirm group with an error has no em dashes either", async () => {
    licenseService.get.mockResolvedValue(lsActive());
    licenseService.deactivate.mockRejectedValue(
      apiError("license_key_needed", ""),
    );
    const user = userEvent.setup();
    const { container } = renderSection();
    await user.click(await screen.findByRole("button", { name: MOVE }));
    await user.click(screen.getByRole("button", { name: "Move license" }));
    await screen.findByRole("alert");
    expect(container.textContent).not.toMatch(/—/);
  });
});
