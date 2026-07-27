-- Candidate retrieval for the trip planner: playable places near a point.
-- Called by the plan-trip edge function (service role); also public-readable
-- since places are public data.

-- Region resolution helpers: centroid of matching places.
create or replace function public.place_centroid(search_city text, niche text default 'golf')
returns table (lat double precision, lng double precision)
language sql stable as $$
  select avg(st_y(location::geometry)), avg(st_x(location::geometry))
  from public.places
  where niche_id = niche and city ilike search_city
  having count(*) > 0;
$$;

create or replace function public.state_centroid(state_code text, niche text default 'golf')
returns table (lat double precision, lng double precision)
language sql stable as $$
  select avg(st_y(location::geometry)), avg(st_x(location::geometry))
  from public.places
  where niche_id = niche and region = upper(state_code)
  having count(*) > 0;
$$;

create or replace function public.places_near(
  center_lat double precision,
  center_lng double precision,
  radius_km double precision default 120,
  max_results int default 60
)
returns table (
  id uuid,
  slug text,
  name text,
  city text,
  region text,
  attrs jsonb,
  description text,
  lat double precision,
  lng double precision,
  distance_km double precision
)
language sql stable as $$
  select p.id, p.slug, p.name, p.city, p.region, p.attrs, p.description,
         st_y(p.location::geometry) as lat,
         st_x(p.location::geometry) as lng,
         st_distance(p.location, st_point(center_lng, center_lat)::geography) / 1000 as distance_km
  from public.places p
  where st_dwithin(p.location, st_point(center_lng, center_lat)::geography, radius_km * 1000)
  order by p.location <-> st_point(center_lng, center_lat)::geography
  limit max_results;
$$;
