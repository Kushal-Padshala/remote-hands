import { describe, expect, it } from 'vitest';
import { deriveBrief } from './brief.js';

describe('deriveBrief: facts', () => {
  it('finds an email, a phone number and a name, verbatim', () => {
    const q = 'sign up with email sam.lee+test@example.co.uk and phone +41 79 123 45 67, my name is Sam Lee';
    const { facts } = deriveBrief(q);
    expect(facts).toEqual({ email: 'sam.lee+test@example.co.uk', phone: '+41 79 123 45 67', name: 'Sam Lee' });
    for (const v of Object.values(facts)) expect(q).toContain(v);
  });

  it('finds quoted text and a search phrase', () => {
    expect(deriveBrief('search for "wireless mouse" on amazon').facts).toMatchObject({ quoted_text: 'wireless mouse', search_query: 'wireless mouse' });
    expect(deriveBrief('search for wireless mouse').facts.search_query).toBe('wireless mouse');
    expect(deriveBrief('search wireless mouse and open the first result').facts.search_query).toBe('wireless mouse');
    expect(deriveBrief('type “hello there” into the box').facts.quoted_text).toBe('hello there');
  });

  it('numbers extra quoted strings and ignores very short ones', () => {
    const { facts } = deriveBrief('fill "first value" and "second value" and "ok"');
    expect(facts).toEqual({ quoted_text: 'first value', quoted_text_2: 'second value' });
  });

  it('takes a password only when the user states it', () => {
    expect(deriveBrief('log in with password hunter2').facts.password).toBe('hunter2');
    expect(deriveBrief('log in with my password: s3cret!').facts.password).toBe('s3cret!');
    expect(deriveBrief('log in with my saved password').facts.password).toBeUndefined();
    expect(deriveBrief('sign in to my account').facts).toEqual({});
  });

  it('finds nothing in an ordinary request', () => {
    expect(deriveBrief('click next until the form is submitted').facts).toEqual({});
  });

  it('does not mistake a url or a version number for a phone number', () => {
    expect(deriveBrief('open https://example.com/a/123456789 and version 1.2.3').facts.phone).toBeUndefined();
  });

  it('copes with very long hostile input quickly', () => {
    const t0 = Date.now();
    deriveBrief(`${'search for '.repeat(5000)}${'a'.repeat(50_000)}`);
    deriveBrief(`${'"'.repeat(20_000)}`);
    deriveBrief(`${'+1 '.repeat(20_000)}`);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('deriveBrief: delegated choices', () => {
  it.each([
    'complete this survey for me',
    'fill out the questionnaire, answer whatever seems best',
    'please finish this quiz',
    'answer the form questions as best you can',
    'do the poll, you choose the answers',
  ])('delegates choices for %j', (q) => {
    const d = deriveBrief(q);
    expect(d.discretion).toBe(true);
    expect(d.brief).toContain(q);
    expect(d.brief).toContain('most reasonable middle answer');
  });

  it.each(['click next until the form is submitted', 'add the cheapest laptop to the cart', 'sign in', 'search for flights'])('does not delegate for %j', (q) => {
    const d = deriveBrief(q);
    expect(d.discretion).toBe(false);
    expect(d.brief).toBeUndefined();
  });
});
