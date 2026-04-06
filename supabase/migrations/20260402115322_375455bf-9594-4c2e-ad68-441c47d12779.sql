
-- Create enums
CREATE TYPE public.convoy_status AS ENUM ('forming', 'active', 'completed');
CREATE TYPE public.convoy_member_role AS ENUM ('leader', 'follower', 'sweep', 'guest');
CREATE TYPE public.convoy_member_status AS ENUM ('active', 'off_route', 'arrived', 'disconnected');
CREATE TYPE public.waypoint_type AS ENUM ('regroup', 'fuel', 'rest');
CREATE TYPE public.waypoint_status AS ENUM ('upcoming', 'active', 'completed');
CREATE TYPE public.alert_type AS ENUM ('off_route', 'regroup', 'hazard', 'gap');
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');

-- Profiles table
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  vehicle_info TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- User roles table (app-level, separate from convoy roles)
CREATE TABLE public.user_roles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Convoys table
CREATE TABLE public.convoys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  leader_id UUID REFERENCES auth.users(id) NOT NULL,
  status public.convoy_status NOT NULL DEFAULT 'forming',
  destination_lat DOUBLE PRECISION,
  destination_lng DOUBLE PRECISION,
  destination_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.convoys ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_convoys_code ON public.convoys(code);

-- Convoy members table
CREATE TABLE public.convoy_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  convoy_id UUID REFERENCES public.convoys(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role public.convoy_member_role NOT NULL DEFAULT 'follower',
  status public.convoy_member_status NOT NULL DEFAULT 'active',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (convoy_id, user_id)
);
ALTER TABLE public.convoy_members ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_convoy_members_convoy ON public.convoy_members(convoy_id);
CREATE INDEX idx_convoy_members_user ON public.convoy_members(user_id);

-- Member locations table (high-frequency ephemeral)
CREATE TABLE public.member_locations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  convoy_id UUID REFERENCES public.convoys(id) ON DELETE CASCADE NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  heading DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (convoy_id, user_id)
);
ALTER TABLE public.member_locations ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_member_locations_convoy ON public.member_locations(convoy_id);

-- Convoy waypoints table
CREATE TABLE public.convoy_waypoints (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  convoy_id UUID REFERENCES public.convoys(id) ON DELETE CASCADE NOT NULL,
  order_index INT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  label TEXT,
  type public.waypoint_type NOT NULL DEFAULT 'regroup',
  status public.waypoint_status NOT NULL DEFAULT 'upcoming',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.convoy_waypoints ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_convoy_waypoints_convoy ON public.convoy_waypoints(convoy_id);

-- Convoy alerts table
CREATE TABLE public.convoy_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  convoy_id UUID REFERENCES public.convoys(id) ON DELETE CASCADE NOT NULL,
  type public.alert_type NOT NULL,
  target_user_id UUID REFERENCES auth.users(id),
  message TEXT,
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.convoy_alerts ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_convoy_alerts_convoy ON public.convoy_alerts(convoy_id);

-- Trip events table
CREATE TABLE public.trip_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  convoy_id UUID REFERENCES public.convoys(id) ON DELETE CASCADE NOT NULL,
  event_type TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id),
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.trip_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_trip_events_convoy ON public.trip_events(convoy_id);

-- ============================================
-- HELPER FUNCTIONS (SECURITY DEFINER)
-- ============================================

CREATE OR REPLACE FUNCTION public.is_convoy_member(_convoy_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.convoy_members
    WHERE convoy_id = _convoy_id AND user_id = auth.uid()
  )
$$;

CREATE OR REPLACE FUNCTION public.is_convoy_leader(_convoy_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.convoy_members
    WHERE convoy_id = _convoy_id AND user_id = auth.uid() AND role = 'leader'
  )
$$;

CREATE OR REPLACE FUNCTION public.has_app_role(_role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = _role
  )
$$;

-- ============================================
-- TRIGGERS
-- ============================================

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_convoys_updated_at BEFORE UPDATE ON public.convoys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_member_locations_updated_at BEFORE UPDATE ON public.member_locations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email));
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Generate 6-char join code for convoys
CREATE OR REPLACE FUNCTION public.generate_convoy_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  new_code TEXT;
BEGIN
  LOOP
    new_code := upper(substr(md5(random()::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.convoys WHERE code = new_code);
  END LOOP;
  NEW.code := new_code;
  RETURN NEW;
END;
$$;

CREATE TRIGGER generate_convoy_code_trigger
  BEFORE INSERT ON public.convoys
  FOR EACH ROW
  WHEN (NEW.code IS NULL OR NEW.code = '')
  EXECUTE FUNCTION public.generate_convoy_code();

-- ============================================
-- RLS POLICIES
-- ============================================

-- Profiles: users see their own, convoy members can see each other
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Convoy members can view member profiles" ON public.profiles FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.convoy_members cm1
    JOIN public.convoy_members cm2 ON cm1.convoy_id = cm2.convoy_id
    WHERE cm1.user_id = auth.uid() AND cm2.user_id = profiles.user_id
  ));

-- User roles
CREATE POLICY "Admins can manage roles" ON public.user_roles FOR ALL USING (public.has_app_role('admin'));
CREATE POLICY "Users can view own roles" ON public.user_roles FOR SELECT USING (auth.uid() = user_id);

-- Convoys: members can see, creator/leader can update
CREATE POLICY "Members can view convoy" ON public.convoys FOR SELECT USING (public.is_convoy_member(id));
CREATE POLICY "Authenticated users can create convoys" ON public.convoys FOR INSERT TO authenticated WITH CHECK (auth.uid() = leader_id);
CREATE POLICY "Leader can update convoy" ON public.convoys FOR UPDATE USING (public.is_convoy_leader(id));
-- Allow viewing convoy by code for joining
CREATE POLICY "Anyone can find convoy by code" ON public.convoys FOR SELECT TO authenticated USING (true);

-- Convoy members
CREATE POLICY "Members can view convoy members" ON public.convoy_members FOR SELECT USING (public.is_convoy_member(convoy_id));
CREATE POLICY "Authenticated users can join convoy" ON public.convoy_members FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Leader can manage members" ON public.convoy_members FOR UPDATE USING (public.is_convoy_leader(convoy_id));
CREATE POLICY "Members can update own status" ON public.convoy_members FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Members can leave convoy" ON public.convoy_members FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Leader can remove members" ON public.convoy_members FOR DELETE USING (public.is_convoy_leader(convoy_id));

-- Member locations
CREATE POLICY "Members can view convoy locations" ON public.member_locations FOR SELECT USING (public.is_convoy_member(convoy_id));
CREATE POLICY "Members can upsert own location" ON public.member_locations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id AND public.is_convoy_member(convoy_id));
CREATE POLICY "Members can update own location" ON public.member_locations FOR UPDATE USING (auth.uid() = user_id AND public.is_convoy_member(convoy_id));

-- Convoy waypoints
CREATE POLICY "Members can view waypoints" ON public.convoy_waypoints FOR SELECT USING (public.is_convoy_member(convoy_id));
CREATE POLICY "Leader can manage waypoints" ON public.convoy_waypoints FOR INSERT WITH CHECK (public.is_convoy_leader(convoy_id));
CREATE POLICY "Leader can update waypoints" ON public.convoy_waypoints FOR UPDATE USING (public.is_convoy_leader(convoy_id));
CREATE POLICY "Leader can delete waypoints" ON public.convoy_waypoints FOR DELETE USING (public.is_convoy_leader(convoy_id));

-- Convoy alerts
CREATE POLICY "Members can view alerts" ON public.convoy_alerts FOR SELECT USING (public.is_convoy_member(convoy_id));
CREATE POLICY "Members can create alerts" ON public.convoy_alerts FOR INSERT WITH CHECK (public.is_convoy_member(convoy_id) AND auth.uid() = created_by);
CREATE POLICY "Leader or target can acknowledge" ON public.convoy_alerts FOR UPDATE USING (public.is_convoy_leader(convoy_id) OR auth.uid() = target_user_id);

-- Trip events
CREATE POLICY "Members can view events" ON public.trip_events FOR SELECT USING (public.is_convoy_member(convoy_id));
CREATE POLICY "Members can create events" ON public.trip_events FOR INSERT WITH CHECK (public.is_convoy_member(convoy_id) AND (auth.uid() = user_id OR public.is_convoy_leader(convoy_id)));

-- Enable realtime for key tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.convoy_members;
ALTER PUBLICATION supabase_realtime ADD TABLE public.member_locations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.convoy_alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.convoys;
