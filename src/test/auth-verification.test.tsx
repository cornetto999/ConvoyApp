import { AuthApiError } from "@supabase/supabase-js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/contexts/AuthContext";
import Auth from "@/pages/Auth";

const { auth } = vi.hoisted(() => ({
  auth: {
    signUp: vi.fn(),
    resend: vi.fn(),
    signInWithPassword: vi.fn(),
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  },
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
vi.mock("@/components/MapExamplesSection", () => ({ default: () => null }));

const email = "driver@example.test";
const redirect = new URL("/login?verified=1", window.location.origin).href;

async function renderAuth(path = "/login") {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider><Auth /></AuthProvider>
      </MemoryRouter>,
    );
  });
}

function submitSignup() {
  fireEvent.click(screen.getByRole("button", { name: /sign up/i }));
  fireEvent.change(screen.getByLabelText("Display Name"), { target: { value: "Test Driver" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password", { exact: true }), { target: { value: "test-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
}

describe("email verification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets an unverified signup request another confirmation link", async () => {
    auth.signUp.mockResolvedValueOnce({ data: { user: { email }, session: null }, error: null });
    auth.resend.mockResolvedValueOnce({ error: null });
    await renderAuth();
    submitSignup();

    expect(await screen.findByText("Verify your email first")).toBeInTheDocument();
    expect(screen.queryByText(/we sent/i)).not.toBeInTheDocument();
    expect(auth.signUp).toHaveBeenCalledWith(expect.objectContaining({
      email,
      options: expect.objectContaining({ emailRedirectTo: redirect }),
    }));

    fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
    expect(screen.getByLabelText("Email")).toHaveValue(email);
    expect(screen.queryByLabelText("Password", { exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request verification link" }));

    expect(await screen.findByText(/if this address has an unverified account/i)).toBeInTheDocument();
    expect(auth.resend).toHaveBeenCalledWith({
      type: "signup", email, options: { emailRedirectTo: redirect },
    });
    expect(screen.getByRole("button", { name: "Try again in a minute" })).toBeDisabled();
  });

  it("shows a delivery restriction instead of claiming the signup email was sent", async () => {
    auth.signUp.mockResolvedValueOnce({
      error: new AuthApiError("Email address not authorized", 403, "email_address_not_authorized"),
    });
    await renderAuth();
    submitSignup();

    expect(await screen.findByRole("alert")).toHaveTextContent("approved test addresses");
    expect(screen.queryByText("Verify your email first")).not.toBeInTheDocument();
  });

  it("opens resend after an expired link and explains rate-limit failures", async () => {
    auth.resend.mockResolvedValueOnce({
      error: new AuthApiError("email rate limit exceeded", 429, "over_email_send_rate_limit"),
    });
    await renderAuth("/login?verified=1#error=access_denied&error_code=otp_expired");

    expect(await screen.findByRole("alert")).toHaveTextContent("verification link has expired");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
    fireEvent.click(screen.getByRole("button", { name: "Request verification link" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("email sending limit was reached");
    expect(screen.queryByText(/if this address has an unverified account/i)).not.toBeInTheDocument();
  });

  it("offers resend to an existing user whose email is unconfirmed", async () => {
    auth.signInWithPassword.mockResolvedValueOnce({
      error: new AuthApiError("Email not confirmed", 400, "email_not_confirmed"),
    });
    await renderAuth();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
    fireEvent.change(screen.getByLabelText("Password", { exact: true }), { target: { value: "test-password" } });
    fireEvent.click(screen.getByRole("button", { name: /^Sign In$/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Verify your email before signing in");
    fireEvent.click(screen.getByRole("button", { name: "Resend verification email" }));
    expect(screen.getByLabelText("Email")).toHaveValue(email);
  });
});
