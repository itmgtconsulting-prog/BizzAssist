-- BIZZ-2184: tilføj embed_url til linkedin_featured_posts.
--
-- Gør det muligt at vise et live LinkedIn-opslag som iframe-embed på forsiden
-- (LinkedIns "Embed this post"-kode), i stedet for kun et kurateret kort.
-- Embeddet loades kun efter cookie-samtykke (tredjepart/GDPR); kortet (image_url
-- + excerpt) er fallback når samtykke mangler eller embed_url er tom.
--
-- Værdien skal være en https://www.linkedin.com/embed/... URL — valideres både
-- i klienten (LinkedInPosts.tsx) og her via CHECK, så et kompromitteret/forkert
-- admin-input ikke kan injicere en vilkårlig iframe-kilde.

ALTER TABLE linkedin_featured_posts
  ADD COLUMN IF NOT EXISTS embed_url text;

ALTER TABLE linkedin_featured_posts
  DROP CONSTRAINT IF EXISTS linkedin_featured_posts_embed_url_https_linkedin;

ALTER TABLE linkedin_featured_posts
  ADD CONSTRAINT linkedin_featured_posts_embed_url_https_linkedin
  CHECK (embed_url IS NULL OR embed_url LIKE 'https://www.linkedin.com/embed/%');

COMMENT ON COLUMN linkedin_featured_posts.embed_url IS
  'LinkedIn iframe-embed URL (https://www.linkedin.com/embed/feed/update/urn:li:share:...). '
  'Vises kun efter cookie-samtykke. NULL = vis kun det kuraterede kort.';
