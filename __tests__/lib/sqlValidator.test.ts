/**
 * Adversarial unit tests for sqlValidator.ts (BIZZ-1424).
 *
 * Sikkerheds-kritisk — testen er bevidst pessimistisk. Dækker:
 *   - DDL/DML/DCL afvises
 *   - System-schemas afvises
 *   - Forbudte funktioner afvises
 *   - Multi-statement afvises
 *   - Kommentarer afslører ikke malicious payload
 *   - Whitelisted SELECT passerer
 *   - LIMIT injectes hvis mangler
 *   - LIMIT > 10000 reduceres
 */
import { describe, it, expect } from 'vitest';
import { validateSql, stripComments } from '@/app/lib/dataIntelligence/sqlValidator';

describe('stripComments', () => {
  it('fjerner line-kommentarer', () => {
    expect(stripComments('SELECT 1 -- this is a comment')).not.toContain('comment');
  });
  it('fjerner blok-kommentarer', () => {
    expect(stripComments('SELECT /* DROP TABLE x */ 1')).not.toContain('DROP');
  });
});

describe('validateSql — happy paths', () => {
  it('tillader simpel SELECT mod whitelistet tabel', () => {
    const result = validateSql('SELECT * FROM public.cvr_virksomhed LIMIT 100');
    expect(result.valid).toBe(true);
  });

  it('tillader short-name reference', () => {
    const result = validateSql('SELECT COUNT(*) FROM cvr_virksomhed');
    expect(result.valid).toBe(true);
  });

  it('tillader WITH (CTE)', () => {
    const result = validateSql(
      'WITH agg AS (SELECT branche_kode, COUNT(*) FROM cvr_virksomhed GROUP BY branche_kode) SELECT * FROM agg ORDER BY count DESC LIMIT 10'
    );
    expect(result.valid).toBe(true);
  });

  it('tillader JOIN mellem to whitelistede tabeller', () => {
    const result = validateSql(
      'SELECT c.cvr, b.bfe_nummer FROM cvr_virksomhed c JOIN ejf_ejerskab e ON e.ejer_cvr = c.cvr JOIN bbr_ejendom_status b ON b.bfe_nummer = e.bfe_nummer LIMIT 100'
    );
    expect(result.valid).toBe(true);
  });

  it('injicér LIMIT hvis mangler', () => {
    const result = validateSql('SELECT * FROM cvr_virksomhed');
    expect(result.valid).toBe(true);
    expect(result.sanitized_sql).toMatch(/LIMIT 10000/);
  });

  it('reducerer for høj LIMIT til 10000', () => {
    const result = validateSql('SELECT * FROM cvr_virksomhed LIMIT 1000000');
    expect(result.valid).toBe(true);
    expect(result.sanitized_sql).toMatch(/LIMIT 10000/);
    expect(result.sanitized_sql).not.toMatch(/1000000/);
  });
});

describe('validateSql — adversarial', () => {
  it('afviser tom SQL', () => {
    expect(validateSql('').valid).toBe(false);
  });

  it('afviser DROP TABLE', () => {
    const r = validateSql('DROP TABLE cvr_virksomhed');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/SELECT|forbudt/i);
  });

  it('afviser INSERT', () => {
    expect(validateSql('INSERT INTO cvr_virksomhed VALUES (1)').valid).toBe(false);
  });

  it('afviser UPDATE', () => {
    expect(validateSql("UPDATE cvr_virksomhed SET navn='x'").valid).toBe(false);
  });

  it('afviser DELETE', () => {
    expect(validateSql('DELETE FROM cvr_virksomhed').valid).toBe(false);
  });

  it('afviser TRUNCATE', () => {
    expect(validateSql('TRUNCATE TABLE cvr_virksomhed').valid).toBe(false);
  });

  it('afviser CREATE', () => {
    expect(validateSql('CREATE TABLE x (id int)').valid).toBe(false);
  });

  it('afviser ALTER', () => {
    expect(validateSql('ALTER TABLE cvr_virksomhed DROP COLUMN cvr').valid).toBe(false);
  });

  it('afviser GRANT', () => {
    expect(validateSql('GRANT ALL ON cvr_virksomhed TO anon').valid).toBe(false);
  });

  it('afviser pg_catalog', () => {
    expect(validateSql('SELECT * FROM pg_catalog.pg_user').valid).toBe(false);
  });

  it('afviser information_schema', () => {
    expect(validateSql('SELECT * FROM information_schema.columns').valid).toBe(false);
  });

  it('afviser auth schema', () => {
    expect(validateSql('SELECT * FROM auth.users LIMIT 10').valid).toBe(false);
  });

  it('afviser pg_sleep DoS', () => {
    expect(validateSql('SELECT pg_sleep(999) FROM cvr_virksomhed').valid).toBe(false);
  });

  it('afviser pg_read_file', () => {
    expect(validateSql("SELECT pg_read_file('/etc/passwd')").valid).toBe(false);
  });

  it('afviser dblink', () => {
    expect(validateSql("SELECT * FROM dblink('host=evil.com')").valid).toBe(false);
  });

  it('afviser multiple statements', () => {
    expect(validateSql('SELECT 1; DROP TABLE cvr_virksomhed').valid).toBe(false);
  });

  it('afviser DROP gemt i kommentar er ikke en bypass (kommentar fjernes først)', () => {
    // Kommentar fjernes så DROP kan ikke gemmes i kommentar; men hvis DROP er
    // i et SQL keyword udenfor kommentar afvises det.
    expect(validateSql('SELECT 1 /* DROP TABLE x */').valid).toBe(true);
  });

  it('afviser ikke-whitelistet tabel', () => {
    expect(validateSql('SELECT * FROM secret_table').valid).toBe(false);
  });

  it('afviser SET ROLE', () => {
    expect(validateSql('SET ROLE postgres').valid).toBe(false);
  });

  it('afviser case-variation: DrOp', () => {
    expect(validateSql('DrOp TABLE cvr_virksomhed').valid).toBe(false);
  });

  it('afviser whitespace-variation: \tSELECT\n;\tDROP', () => {
    expect(validateSql('\tSELECT 1;\tDROP TABLE cvr_virksomhed').valid).toBe(false);
  });

  it('afviser SQL > 10000 chars', () => {
    const huge = 'SELECT ' + 'a,'.repeat(5000) + 'b FROM cvr_virksomhed';
    expect(validateSql(huge).valid).toBe(false);
  });

  it('afviser PERFORM som første ord', () => {
    expect(validateSql('PERFORM pg_sleep(10)').valid).toBe(false);
  });

  it('afviser CALL procedure', () => {
    expect(validateSql('CALL secret_proc()').valid).toBe(false);
  });
});

describe('validateSql — edge cases', () => {
  it('tillader date_trunc (ikke forveksles med TRUNCATE)', () => {
    const r = validateSql(
      "SELECT date_trunc('month', stiftet) AS m, COUNT(*) FROM cvr_virksomhed GROUP BY m LIMIT 12"
    );
    expect(r.valid).toBe(true);
  });

  it('tillader semicolon i slutningen (trimmes)', () => {
    expect(validateSql('SELECT 1 FROM cvr_virksomhed;').valid).toBe(true);
  });

  it('CTE-aliaser ikke fejlagtigt afvises som ikke-whitelistet', () => {
    const r = validateSql(
      'WITH topcvr AS (SELECT cvr FROM cvr_virksomhed LIMIT 100) SELECT cvr FROM topcvr'
    );
    expect(r.valid).toBe(true);
  });
});
