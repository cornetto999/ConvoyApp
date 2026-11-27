import React, { createContext, useContext, useEffect, useState } from "react";
import { AuthApiError, type Session, type User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Profile } from "@/types/convoy";

type SignUpResult = {
  requiresEmailVerification: boolean;
  email: string;
};

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signUp: (email: string, password: string, displayName: string) => Promise<SignUpResult>;
  signIn: (email: string, password: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function getVerificationRedirect() {
  return new URL("/login?verified=1", window.location.origin).href;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const bootstrapTimeout = window.setTimeout(() => {
      if (mounted) setLoading(false);
    }, 3000);

    const loadProfile = async (userId: string) => {
      try {
        const { data } = await supabase
          .from("profiles")
          .select("*")
          .eq("user_id", userId)
          .single();

        if (mounted) {
          setProfile(data || null);
        }
      } catch {
        if (mounted) {
          setProfile(null);
        }
      }
    };

    const applySession = (nextSession: Session | null) => {
      if (!mounted) return;

      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setLoading(false);

      if (nextSession?.user) {
        void loadProfile(nextSession.user.id);
      } else {
        setProfile(null);
      }
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      applySession(nextSession);
    });

    const init = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!mounted) return;
        if (error) {
          applySession(null);
          return;
        }
        applySession(data.session);
      } catch {
        if (mounted) {
          applySession(null);
        }
      }
    };

    void init();

    return () => {
      mounted = false;
      window.clearTimeout(bootstrapTimeout);
      subscription.unsubscribe();
    };
  }, []);

  const signUp = async (email: string, password: string, displayName: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: getVerificationRedirect(),
      },
    });

    if (error) {
      throw error;
    }

    const requiresEmailVerification = !data.user?.email_confirmed_at;
    if (requiresEmailVerification && data.session) {
      await supabase.auth.signOut();
    }

    return {
      requiresEmailVerification,
      email,
    };
  };

  const resendVerification = async (email: string) => {
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: getVerificationRedirect() },
    });
    if (error) throw error;
  };

  const signIn = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (!data.user?.email_confirmed_at) {
      await supabase.auth.signOut();
      throw new AuthApiError("Email not confirmed", 400, "email_not_confirmed");
    }
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  return (
    <AuthContext.Provider value={{ session, user, profile, loading, signUp, signIn, resendVerification, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
