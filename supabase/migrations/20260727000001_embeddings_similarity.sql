-- Embeddings use bge-small-en-v1.5 (384 dims, generated locally — no metered
-- API). Resize the column and add the similarity lookup.

alter table public.places drop column if exists embedding;
alter table public.places add column embedding vector (384);

-- ivfflat needs rows to exist before it's useful; created after first embed
-- load is fine (planner falls back to seq scan until then).
create index if not exists places_embedding_idx
  on public.places using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Nearest neighbours to a given place, same niche, excluding itself.
create or replace function public.match_places(source_place_id uuid, match_count int default 6)
returns table (id uuid, slug text, name text, city text, region text, similarity float)
language sql stable as $$
  select p.id, p.slug, p.name, p.city, p.region,
         1 - (p.embedding <=> s.embedding) as similarity
  from public.places s
  join public.places p
    on p.niche_id = s.niche_id
   and p.id <> s.id
   and p.embedding is not null
  where s.id = source_place_id
    and s.embedding is not null
  order by p.embedding <=> s.embedding
  limit match_count;
$$;
