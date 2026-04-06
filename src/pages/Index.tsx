import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Navigation, Plus, LogIn, LogOut, Route, Users, ChevronRight, MapPin } from "lucide-react";
import type { Convoy } from "@/types/convoy";

type ConvoyWithMemberCount = Convoy & { member_count: number; my_role: string };

export default function Index() {
  const { user, profile, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [convoyName, setConvoyName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [myConvoys, setMyConvoys] = useState<ConvoyWithMemberCount[]>([]);
  const [loadingConvoys, setLoadingConvoys] = useState(false);

  useEffect(() => {
    if (user) loadMyConvoys();
  }, [user]);

  // Redirect after render to avoid navigation during render (React warns otherwise)
  useEffect(() => {
    if (!loading && !user) {
      navigate("/login");
    }
  }, [loading, user, navigate]);

  const loadMyConvoys = async () => {
    if (!user) return;
    setLoadingConvoys(true);
    try {
      // Get convoys the user is a member of
      const { data: memberships } = await supabase
        .from("convoy_members")
        .select("convoy_id, role")
        .eq("user_id", user.id);

      if (!memberships || memberships.length === 0) {
        setMyConvoys([]);
        setLoadingConvoys(false);
        return;
      }

      const convoyIds = memberships.map((m) => m.convoy_id);
      const { data: convoys } = await supabase
        .from("convoys")
        .select("*")
        .in("id", convoyIds)
        .order("created_at", { ascending: false });

      if (convoys) {
        // Get member counts per convoy
        const enriched: ConvoyWithMemberCount[] = [];
        for (const convoy of convoys) {
          const { count } = await supabase
            .from("convoy_members")
            .select("*", { count: "exact", head: true })
            .eq("convoy_id", convoy.id);
          const membership = memberships.find((m) => m.convoy_id === convoy.id);
          enriched.push({
            ...convoy,
            member_count: count || 0,
            my_role: membership?.role || "follower",
          });
        }
        setMyConvoys(enriched);
      }
    } catch (err) {
      console.error("Failed to load convoys:", err);
    } finally {
      setLoadingConvoys(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse flex items-center gap-3">
          <Navigation className="w-6 h-6 text-primary" />
          <span className="text-lg font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const handleCreateConvoy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!convoyName.trim()) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase
        .from("convoys")
        .insert({ name: convoyName.trim(), leader_id: user.id, code: "" })
        .select()
        .single();

      if (error) throw error;

      await supabase.from("convoy_members").insert({
        convoy_id: data.id,
        user_id: user.id,
        role: "leader" as const,
      });

      toast.success(`Convoy "${data.name}" created! Code: ${data.code}`);
      setCreateOpen(false);
      setConvoyName("");
      navigate(`/convoy/${data.id}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to create convoy");
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoinConvoy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim()) return;
    setSubmitting(true);
    try {
      const { data: convoy, error: findError } = await supabase
        .from("convoys")
        .select("*")
        .eq("code", joinCode.trim().toUpperCase())
        .single();

      if (findError || !convoy) throw new Error("Convoy not found. Check your code.");

      const { error: joinError } = await supabase.from("convoy_members").insert({
        convoy_id: convoy.id,
        user_id: user.id,
        role: "follower" as const,
      });

      if (joinError) {
        if (joinError.code === "23505") {
          toast.info("You're already in this convoy!");
          navigate(`/convoy/${convoy.id}`);
          return;
        }
        throw joinError;
      }

      toast.success(`Joined "${convoy.name}"!`);
      setJoinOpen(false);
      setJoinCode("");
      navigate(`/convoy/${convoy.id}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to join convoy");
    } finally {
      setSubmitting(false);
    }
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case "active":
        return <Badge className="bg-primary/10 text-primary border-0">Active</Badge>;
      case "completed":
        return <Badge variant="secondary">Completed</Badge>;
      default:
        return <Badge variant="outline">Forming</Badge>;
    }
  };

  const activeConvoys = myConvoys.filter((c) => c.status !== "completed");
  const pastConvoys = myConvoys.filter((c) => c.status === "completed");

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
              <Navigation className="w-5 h-5 text-primary" />
            </div>
            <span className="font-bold text-lg tracking-tight">Convoy</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground hidden sm:block">
              {profile?.display_name || user.email}
            </span>
            <Button variant="ghost" size="icon" onClick={signOut}>
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Hero */}
        <div className="text-center space-y-4 py-4">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            Navigate <span className="text-primary">together</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-md mx-auto">
            Create or join a convoy, share destinations, and travel as one unit.
          </p>
        </div>

        {/* Action Cards */}
        <div className="grid sm:grid-cols-2 gap-4">
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Card className="cursor-pointer hover:border-primary/50 hover:shadow-md transition-all group">
                <CardHeader>
                  <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mb-2 group-hover:bg-primary/20 transition-colors">
                    <Plus className="w-6 h-6 text-primary" />
                  </div>
                  <CardTitle className="text-lg">Create Convoy</CardTitle>
                  <CardDescription>
                    Start a new convoy and invite others with a join code
                  </CardDescription>
                </CardHeader>
              </Card>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create a New Convoy</DialogTitle>
                <DialogDescription>
                  Name your convoy. A unique join code will be generated automatically.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateConvoy} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="convoyName">Convoy Name</Label>
                  <Input
                    id="convoyName"
                    placeholder="Weekend Road Trip"
                    value={convoyName}
                    onChange={(e) => setConvoyName(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? "Creating..." : "Create Convoy"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
            <DialogTrigger asChild>
              <Card className="cursor-pointer hover:border-accent/50 hover:shadow-md transition-all group">
                <CardHeader>
                  <div className="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center mb-2 group-hover:bg-accent/20 transition-colors">
                    <LogIn className="w-6 h-6 text-accent" />
                  </div>
                  <CardTitle className="text-lg">Join Convoy</CardTitle>
                  <CardDescription>
                    Enter a 6-character code to join an existing convoy
                  </CardDescription>
                </CardHeader>
              </Card>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Join a Convoy</DialogTitle>
                <DialogDescription>
                  Enter the convoy code shared by the leader.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleJoinConvoy} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="joinCode">Convoy Code</Label>
                  <Input
                    id="joinCode"
                    placeholder="ABC123"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    maxLength={6}
                    className="text-center text-2xl tracking-[0.3em] font-mono uppercase"
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? "Joining..." : "Join Convoy"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* My Convoys */}
        {loadingConvoys ? (
          <div className="text-center py-8 text-muted-foreground">Loading your convoys...</div>
        ) : myConvoys.length > 0 ? (
          <div className="space-y-6">
            {activeConvoys.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Navigation className="w-5 h-5 text-primary" />
                  Active Convoys
                </h2>
                <div className="space-y-2">
                  {activeConvoys.map((convoy) => (
                    <Card
                      key={convoy.id}
                      className="cursor-pointer hover:border-primary/30 transition-all"
                      onClick={() => navigate(`/convoy/${convoy.id}`)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                              <Navigation className="w-5 h-5 text-primary" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold truncate">{convoy.name}</p>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Users className="w-3 h-3" />
                                {convoy.member_count} members
                                <span className="capitalize">• {convoy.my_role}</span>
                                {convoy.destination_address && (
                                  <>
                                    <MapPin className="w-3 h-3" />
                                    <span className="truncate max-w-[120px]">{convoy.destination_address}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {statusBadge(convoy.status)}
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {pastConvoys.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-lg font-semibold text-muted-foreground">Past Convoys</h2>
                <div className="space-y-2">
                  {pastConvoys.map((convoy) => (
                    <Card
                      key={convoy.id}
                      className="cursor-pointer hover:border-border transition-all opacity-70 hover:opacity-100"
                      onClick={() => navigate(`/convoy/${convoy.id}`)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                              <Route className="w-5 h-5 text-muted-foreground" />
                            </div>
                            <div>
                              <p className="font-medium">{convoy.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {convoy.member_count} members • {convoy.my_role}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {statusBadge(convoy.status)}
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
