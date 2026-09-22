// The hand evaluator decides who gets the money, so it gets real tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compareHands } from '../src/games/handrank.js';
import { freshDeck, shuffle } from '../src/games/cards.js';

const ev = (s) => evaluate(s.split(' '));

test('recognises every category', () => {
  const cases = [
    ['As Ks Qs Js Ts 2h 3d', 'Straight Flush', 'Royal Flush'],
    ['9h 8h 7h 6h 5h Ad Kc', 'Straight Flush', 'Straight Flush, 9 high'],
    ['7c 7d 7h 7s Kd 2c 3h', 'Four of a Kind', 'Four 7s'],
    ['Qc Qd Qh 4s 4d 9c 2h', 'Full House', 'Full House, Qs over 4s'],
    ['Ah Jh 8h 5h 2h Kd Qc', 'Flush', 'Flush, A high'],
    ['9c 8d 7h 6s 5c Ah Kd', 'Straight', 'Straight, 9 high'],
    ['Ks Kd Kh 7c 4d 2h 9s', 'Three of a Kind', 'Three Ks'],
    ['Ac Ad 9h 9s 4c 2d 7h', 'Two Pair', 'Two Pair, As and 9s'],
    ['Jc Jd 9h 6s 4c 2d 3h', 'Pair', 'Pair of Js'],
    ['Ac Jd 9h 6s 4c 2d 3h', 'High Card', 'A high'],
  ];
  for (const [cards, category, label] of cases) {
    const r = ev(cards);
    assert.equal(r.category, category, `${cards} -> ${r.category}`);
    assert.equal(r.label, label, `${cards} -> ${r.label}`);
    assert.equal(r.cards.length, 5, `${cards} picked ${r.cards.length} cards`);
  }
});

test('the wheel is a five-high straight, not an ace-high one', () => {
  const wheel = ev('Ac 2d 3h 4s 5c Kd Qh');
  assert.equal(wheel.category, 'Straight');
  assert.equal(wheel.label, 'Straight, 5 high');
  // and it must lose to any higher straight
  assert.ok(compareHands(ev('6c 2d 3h 4s 5c Kd Qh'), wheel) > 0);
});

test('steel wheel is a straight flush', () => {
  const r = ev('Ah 2h 3h 4h 5h Kd Qc');
  assert.equal(r.category, 'Straight Flush');
  assert.equal(r.label, 'Straight Flush, 5 high');
});

test('ranks categories in the right order', () => {
  const ladder = [
    'Ac Jd 9h 6s 4c 2d 3h',   // high card
    'Jc Jd 9h 6s 4c 2d 3h',   // pair
    'Ac Ad 9h 9s 4c 2d 7h',   // two pair
    'Ks Kd Kh 7c 4d 2h 9s',   // trips
    '9c 8d 7h 6s 5c Ah Kd',   // straight
    'Ah Jh 8h 5h 2h Kd Qc',   // flush
    'Qc Qd Qh 4s 4d 9c 2h',   // full house
    '7c 7d 7h 7s Kd 2c 3h',   // quads
    '9h 8h 7h 6h 5h Ad Kc',   // straight flush
  ].map(ev);
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(compareHands(ladder[i], ladder[i - 1]) > 0,
      `${ladder[i].label} should beat ${ladder[i - 1].label}`);
  }
});

test('kickers decide when categories match', () => {
  assert.ok(compareHands(ev('Ac Ad Kh 9s 4c 2d 3h'), ev('Ac Ad Qh 9s 4c 2d 3h')) > 0, 'better kicker wins');
  assert.equal(compareHands(ev('Ac Ad Kh 9s 4c 2d 3h'), ev('As Ah Kd 9c 4h 2s 3c')), 0, 'same hand ties');
  assert.ok(compareHands(ev('Ah Kh Qh Jh 9h 2c 3d'), ev('Ac Kc Qc Jc 8c 2h 3s')) > 0, 'flush compares all five');
});

test('two pair uses the best two pairs and one kicker', () => {
  // Three pairs are available. Aces and kings play; the queen pair contributes
  // exactly one card, as the highest remaining kicker -- not two.
  const r = ev('Ac Ad Kh Ks Qc Qd 3h');
  assert.equal(r.label, 'Two Pair, As and Ks');
  const queens = r.cards.filter((c) => c[0] === 'Q');
  assert.equal(queens.length, 1, `the third pair may only lend a kicker, got ${queens.join(' ')}`);
  assert.equal(r.cards.filter((c) => c[0] === 'A').length, 2);
  assert.equal(r.cards.filter((c) => c[0] === 'K').length, 2);
});

test('a lower two pair with a better kicker still loses to higher pairs', () => {
  assert.ok(compareHands(ev('Ac Ad Kh Ks 2c 3d 4h'), ev('Qc Qd Jh Js Ac 3d 4h')) > 0);
});

test('full house prefers the higher trips when two are present', () => {
  const r = ev('9c 9d 9h 4s 4d 4c 2h');
  assert.equal(r.label, 'Full House, 9s over 4s');
});

test('a flush beats a straight made of the same cards', () => {
  const straightOnly = ev('9c 8d 7h 6s 5c 2d 3h');
  const straightFlush = ev('9h 8h 7h 6h 5h 2d 3c');
  assert.ok(compareHands(straightFlush, straightOnly) > 0);
});

test('never throws and always returns five cards across many random deals', () => {
  for (let i = 0; i < 3000; i++) {
    const deck = shuffle(freshDeck());
    const r = evaluate(deck.slice(0, 7));
    assert.equal(r.cards.length, 5);
    assert.equal(new Set(r.cards).size, 5, 'best hand must not repeat a card');
    assert.ok(Number.isFinite(r.score) && r.score > 0);
  }
});

test('five-card and six-card hands work too', () => {
  assert.equal(evaluate('Ac Kc Qc Jc Tc'.split(' ')).label, 'Royal Flush');
  assert.equal(evaluate('Ac Ad 5h 5s 9c 2d'.split(' ')).label, 'Two Pair, As and 5s');
});
