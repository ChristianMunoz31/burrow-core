import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LicenseSection from "../LicenseSection";
import { ToastProvider } from "../../../contexts/ToastContext";
import { LICENSE_DEPENDENT_QUERY_KEY } from "../../../hooks/useLicense";
import { FREE, GUM_BUTTON, GUM_KEY, paste, renderSection, status } from "./licenseFixtures";

vi.mock("../../../services/licenseService", () => ({
  licenseService: { get: vi.fn(), activate: vi.fn(), deactivate: vi.fn(), remove: vi.fn() },
}));
import { licenseService } from "../../../services/licenseService";

const HINT = "Test purchases only work in Burrow Dev. Activate a real license key to turn Pro on.";

beforeEach(() => licenseService.get.mockResolvedValue(FREE));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LicenseSection test purchase hint", () => {
  it("explains a refused test key on a plain Free state", async () => {
    licenseService.get.mockResolvedValue({ ...FREE, reasons: ["test_purchase"] });
    renderSection();
    expect(await screen.findByText(HINT)).toBeInTheDocument();
  });

  it("is absent for plain Free and for a licensed test purchase (that one has its own badge)", async () => {
    renderSection();
    await screen.findByTestId("license-state");
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    cleanup();
    licenseService.get.mockResolvedValue(status({ reasons: ["test_purchase"] }));
    renderSection();
    await screen.findByTestId("license-state");
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});

describe("LicenseSection and the license-dependent cache", () => {
  it("invalidates the license-dependent queries after a real Activate", async () => {
    licenseService.activate.mockResolvedValue(status());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <LicenseSection />
        </ToastProvider>
      </QueryClientProvider>,
    );
    await paste(user, GUM_KEY);
    await user.click(screen.getByRole("button", { name: GUM_BUTTON }));
    await waitFor(() => expect(licenseService.activate).toHaveBeenCalled());
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: LICENSE_DEPENDENT_QUERY_KEY }));
  });
});
