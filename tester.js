/* tester.js — the "Download with tester" build (makeTester): a track plus command blocks that
   run the cart and report in chat. Needs engine.js and litematic.js. */

/*
  Single-track tester for the floatcart finder: a track plus command blocks that test it by
  themselves once the schematic is pasted. Its design began in the retired Python tester,
  whose parts worked in game; this is now the reference.
  makeTester(E, LW): E = makeEngine(), LW = makeLitematicWriter().
*/
function makeTester(E, LW) {
  'use strict';
  var SUMMON_T = 60;
  var TOP = '0.699999988079071', F1E5 = '0.000009999999747378752';
  var HEIGHT = 0.699999988079071, HALF_W = Math.fround(Math.fround(0.98) / 2);
  var FACING_NAME = { '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' };
  var GLASS = 'minecraft:white_stained_glass', SIGN = 'minecraft:cherry_wall_sign';

  function zeros(n) { var s = ''; while (n-- > 0) s += '0'; return s; }
  // A double as a plain decimal (commands take no exponents): the shortest digits that give
  // the same double back, no trailing zeros, integers without a point (as tester.plain)
  function plain(v) {
    if (v === 0) return '0';
    var m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(v.toExponential());
    var digits = m[2] + (m[3] || ''), point = parseInt(m[4], 10) + 1, out;
    if (point <= 0) out = '0.' + zeros(-point) + digits;
    else if (point >= digits.length) out = digits + zeros(point - digits.length);
    else out = digits.slice(0, point) + '.' + digits.slice(point);
    return m[1] + out;
  }
  function frac10(v) { return v.toFixed(10); }
  function rangeText(lo, hi) {
    return lo <= hi ? frac10(lo) + ' to ' + frac10(hi) : frac10(lo) + ' to 1 or 0 to ' + frac10(hi);
  }
  function cmdState(kind, facing) {
    var name = { impulse: 'minecraft:command_block', chain: 'minecraft:chain_command_block', repeat: 'minecraft:repeating_command_block' }[kind];
    return { name: name, props: { conditional: 'false', facing: facing } };
  }
  function cmdData(command, auto) {
    return [['id', ['string', 'minecraft:command_block']], ['Command', ['string', command]], ['auto', ['byte', auto ? 1 : 0]],
      ['powered', ['byte', 0]], ['conditionMet', ['byte', 0]], ['TrackOutput', ['byte', 0]],
      ['SuccessCount', ['int', 0]], ['UpdateLastExecution', ['byte', 1]]];
  }
  function signData(lines) {
    function side(msgs) {
      return ['compound', [['color', ['string', 'black']], ['messages', ['list', 8, msgs.map(function (t) { return ['string', t]; })]],
        ['has_glowing_text', ['byte', 0]]]];
    }
    return [['id', ['string', 'minecraft:sign']], ['is_waxed', ['byte', 0]], ['front_text', side(lines)],
      ['back_text', side(['', '', '', ''])], ['components', ['compound', []]]];
  }

  // Blocks, block entities and info for one tester. startRail: the block of the start rail;
  // ticks: how long the cart takes to park, counted from its summon (file() works it out). opt:
  // the start, as E.run takes it. A cart placed by hand is summoned on the start rail; a launched
  // one (opt.how 'fly') or one on a loading run ('loader') where it would be placed (M3), and with
  // opt.boat a boat is summoned on its rail first, for the cart to take aboard on its way down.
  // On a loading run the cart then waits against the stopper until LOAD_WAIT ticks after its
  // summon, when the commands break the glass under it (and put it back for the next test).
  var LOAD_WAIT = 240;
  function build(code, startRail, facing, axis, lo, hi, uid, ticks, opt) {
    var L = E.parse(code), start = L.start, how = E.startHow(opt);
    var origin = start === 'S' ? [startRail[0], startRail[1], startRail[2]] : [startRail[0], startRail[1] + 1, startRail[2]];
    var b = E.build(code, origin, facing, opt), f = E.FACINGS[facing], La = b.launcher || b.loader, Lo = b.loader;
    var ys = b.ys, last = ys.length - 1;
    if (axis !== 'y' && (axis === 'x') !== (f.du !== 0)) throw new Error('x needs a track running east or west, z north or south');
    function at(k, y, side) { side = side || 0; return [origin[0] + f.du * k + f.lu * side, origin[1] + y, origin[2] + f.dv * k + f.lv * side]; }
    var list = b.blocks.slice(), taken = {}, tes = [];
    list.forEach(function (q) { taken[q.x + ',' + q.y + ',' + q.z] = q; });
    function put(p, st, data) {
      var key = p.join(',');
      if (taken[key]) throw new Error('overlap at ' + key);
      var q = { x: p[0], y: p[1], z: p[2], name: st.name, props: st.props };
      taken[key] = q; list.push(q);
      if (data) tes.push({ x: p[0], y: p[1], z: p[2], data: data });
    }
    var obj = 'fct' + uid, tag = obj, ptag = 'fctp' + uid, ftag = 'fctf' + uid, btag = 'fctb' + uid;
    var minY = Infinity;
    b.blocks.forEach(function (q) { minY = Math.min(minY, q.y); });
    var yb = minY - origin[1] - 2, t = '#t ' + obj + ' matches', tb = null, check;
    if (axis === 'y') check = SUMMON_T + ticks + 40;
    else { tb = SUMMON_T + ticks + 20; check = tb + 40; }
    var limit = Math.max(1000, check + 10);

    var lift = start === 'S' ? 0.0625 : 0.5625, dy = (ys[0] + lift) - (yb + 0.5);
    function summonCart(dyy) {
      return 'execute if score ' + t + ' ' + SUMMON_T + '.. unless entity @e[type=minecart,tag=' + tag + '] run summon minecart ' +
        '~ ~' + plain(dyy) + ' ~ {Tags:["' + tag + '"],CustomName:"Test cart",CustomNameVisible:1b}';
    }
    if (!La) put(at(0, yb), cmdState('repeat', 'up'), cmdData(summonCart(dy), true));
    var park = at(last, ys[last]), info = { code: code, axis: axis, lo: lo, hi: hi, check: check, tb: tb, summon: La ? null : at(0, yb), dy: dy, park: park,
                                            how: how, boat: !!(La && La.boat) };
    if (axis !== 'y') {
      put(at(last, yb), cmdState('repeat', 'up'), cmdData('execute if score ' + t + ' ' + tb + ' run setblock ~ ~' + (ys[last] - yb) + ' ~ air', true));
      put(at(last, yb - 1), cmdState('repeat', 'up'), cmdData(
        'execute if score ' + t + ' 10 run clone ~ ~-2 ~ ~ ~-2 ~ ~ ~' + (ys[last] - (yb - 1)) + ' ~', true));
      var pr = taken[park.join(',')];
      put(at(last, yb - 3), { name: pr.name, props: pr.props });
      put(at(last, yb - 4), { name: GLASS, props: {} });
      put(at(last + 1, yb - 3), { name: GLASS, props: {} });
    }
    var sideFacing = FACING_NAME[f.lu + ',' + f.lv], back = FACING_NAME[(0 - f.du) + ',' + (0 - f.dv)];
    var reset = ['gamerule commandBlockOutput false', 'gamerule command_block_output false',
      'scoreboard objectives add ' + obj + ' dummy', 'scoreboard players set #t ' + obj + ' 0'];
    var y0 = ys[0], s;
    for (s = 0; s < reset.length; s++) put(at(-3, y0, s), cmdState(s === 0 ? 'impulse' : 'chain', sideFacing), cmdData(reset[s], true));
    for (s = 0; s < reset.length; s++) put(at(-5, y0, s), cmdState(s === 0 ? 'impulse' : 'chain', sideFacing), cmdData(reset[s], s > 0));
    put(at(-6, y0, 0), { name: 'minecraft:stone_button', props: { face: 'wall', facing: back, powered: 'false' } });
    put(at(-6, y0, 1), { name: SIGN, props: { facing: back, waterlogged: 'false' } },
      signData(['', 'Retest', '', '']));

    var rt = rangeText(lo, hi);
    var what = { y: 'y', x: 'x after the drop', z: 'z after the drop' }[axis];
    var secs = Math.floor((check + 14) / 20);
    var lines = [
      'execute unless score ' + t + ' ' + limit + '.. run scoreboard players add #t ' + obj + ' 1',
      'execute if score ' + t + ' 1 run tellraw @a {"text":"Testing... results in ' + secs + 's","color":"gray"}',
      'execute if score ' + t + ' 8 as @e[type=minecart,tag=' + tag + '] at @s run fill ~ ~2 ~ ~ ~2 ~ air replace #minecraft:wool',
      'execute if score ' + t + ' 10 run tp @e[type=minecart,tag=' + tag + '] ~ -400 ~'
    ];
    var sel = 'execute if score ' + t + ' ' + check + ' as @e[type=minecart,tag=' + tag + '] at @s', a, c, ta, tc;
    if (axis === 'y') {
      a = lo + HEIGHT; c = hi - 1.0;
      ta = 'align y positioned ~ ~' + plain(a) + ' ~ if entity @s[dx=0,dy=0,dz=0]';
      tc = 'align y positioned ~ ~' + plain(c) + ' ~ if entity @s[dx=0,dy=0,dz=0]';
    } else {
      a = lo + HALF_W; c = hi - HALF_W - 1.0;
      if (axis === 'x') {
        ta = 'align x positioned ~' + plain(a) + ' ~ ~ if entity @s[dx=0,dy=0,dz=0]';
        tc = 'align x positioned ~' + plain(c) + ' ~ ~ if entity @s[dx=0,dy=0,dz=0]';
      } else {
        ta = 'align z positioned ~ ~ ~' + plain(a) + ' if entity @s[dx=0,dy=0,dz=0]';
        tc = 'align z positioned ~ ~ ~' + plain(c) + ' if entity @s[dx=0,dy=0,dz=0]';
      }
    }
    if (lo <= hi) lines.push(sel + ' ' + ta + ' at @s ' + tc + ' run tag @s add ' + ptag);
    else { lines.push(sel + ' ' + ta + ' run tag @s add ' + ptag); lines.push(sel + ' ' + tc + ' run tag @s add ' + ptag); }
    if (axis === 'y') lines.push(sel + ' positioned ~ ~' + TOP + ' ~ align y if entity @s[dx=0,dy=0,dz=0] positioned ~ ~' + F1E5 + ' ~ ' +
      'unless entity @s[dx=0,dy=0,dz=0] run tag @s add ' + ftag);
    info.a = a; info.c = c;
    lines.push('execute if score ' + t + ' ' + (check + 1) + ' as @e[type=minecart,tag=' + tag + '] at @s run fill ~ ~2 ~ ~ ~2 ~ air replace #minecraft:wool');
    lines.push('execute if score ' + t + ' ' + (check + 2) + ' if entity @e[type=minecart,tag=' + ptag + '] run tellraw @a ["",{"text":"PASS","bold":true,"color":"green"},{"text":" ' + what + ' within ' + rt + '"}]');
    lines.push('execute if score ' + t + ' ' + (check + 2) + ' unless entity @e[type=minecart,tag=' + ptag + '] run tellraw @a ["",{"text":"FAIL","bold":true,"color":"red"},{"text":" ' + what + ' outside ' + rt + '"}]');
    lines.push('execute if score ' + t + ' ' + (check + 2) + ' as @e[type=minecart,tag=' + ptag + '] at @s run setblock ~ ~2 ~ lime_wool keep');
    lines.push('execute if score ' + t + ' ' + (check + 2) + ' as @e[type=minecart,tag=' + tag + ',tag=!' + ptag + '] at @s run setblock ~ ~2 ~ red_wool keep');
    if (axis === 'y') {
      lines.push('execute if score ' + t + ' ' + (check + 3) + ' if entity @e[type=minecart,tag=' + ftag + '] run tellraw @a {"text":"Floatcart!","color":"green"}');
      lines.push('execute if score ' + t + ' ' + (check + 3) + ' unless entity @e[type=minecart,tag=' + ftag + '] run tellraw @a {"text":"Not a floatcart","color":"gray"}');
    }
    lines.push('execute if score ' + t + ' ' + (check + 4) + ' run tellraw @a ["",{"text":"Pos: ","color":"gray"},' +
      '{"entity":"@e[type=minecart,tag=' + tag + ',limit=1]","nbt":"Pos"}]');
    if (La && La.boat) lines.splice(3, 0, 'execute if score ' + t + ' 9 run tp @e[type=oak_boat,tag=' + btag + '] ~ -400 ~');
    for (var k = 0; k < lines.length; k++) put(at(k, yb, 2), cmdState('repeat', 'up'), cmdData(lines[k], true));
    // A launched cart: summoned where it would be placed on the launcher, by a command block in the
    // first free cell under that spot; its boat 20 ticks earlier, the same way, in the middle of its rail
    function under(p, command) {
      for (var y = origin[1] + yb; ; y--) {
        if (taken[p[0] + ',' + y + ',' + p[2]]) continue;
        put([p[0], y, p[2]], cmdState('repeat', 'up'), cmdData(command(y), true));
        return [p[0], y, p[2]];
      }
    }
    if (La) {
      info.summon = under(La.start, function (y) { info.dy = La.place[1] - (y + 0.5); return summonCart(info.dy); });
      if (Lo) {                                           // break the glass under the loaded cart, and restore it for the next test
        var g = Lo.breakGlass, rl = taken[Lo.lastRail.join(',')], shape = 'minecraft:rail[shape=' + rl.props.shape + ']', tg = SUMMON_T + LOAD_WAIT;
        info.breakAt = tg;
        under(g, function (y) { return 'execute if score ' + t + ' ' + tg + ' run setblock ~ ~' + (g[1] - y) + ' ~ air'; });
        under(g, function (y) { return 'execute if score ' + t + ' 5 run setblock ~ ~' + (g[1] - y) + ' ~ ' + GLASS; });
        under(g, function (y) { return 'execute if score ' + t + ' 6 run setblock ~ ~' + (g[1] + 1 - y) + ' ~ ' + shape; });
        under(g, function (y) { return 'execute if score ' + t + ' 7 positioned ~ ~' + (g[1] - y) + ' ~ run kill @e[type=item,distance=..3]'; });
      }
      if (La.boat) info.boatSummon = under(La.boatRail, function (y) {
        return 'execute if score ' + t + ' ' + (SUMMON_T - 20) + '.. unless entity @e[type=oak_boat,tag=' + btag + '] run summon oak_boat ~ ~' +
          plain(La.boat[1] - (y + 0.5)) + ' ~ {Tags:["' + btag + '"]}';
      });
    }
    info.lines = lines; info.secs = secs;
    return { blocks: list, tes: tes, info: info, startRail: at(0, ys[0]) };
  }

  // The tests as the commands make them, on a cart at (x, y, z) (as tester.verdict)
  function boxHit(cmin, cmax, bmin) { return cmin < bmin + 1.0 && cmax > bmin; }
  function verdict(info, x, y, z) {
    var ha, hc, b, v;
    if (info.axis === 'y') { b = Math.floor(y); ha = boxHit(y, y + HEIGHT, b + info.a); hc = boxHit(y, y + HEIGHT, b + info.c); }
    else {
      v = info.axis === 'x' ? x : z; b = Math.floor(v);
      ha = boxHit(v - HALF_W, v + HALF_W, b + info.a); hc = boxHit(v - HALF_W, v + HALF_W, b + info.c);
    }
    var top = Math.floor(y + Number(TOP));
    return { passed: info.lo <= info.hi ? ha && hc : ha || hc,
             floatcart: boxHit(y, y + HEIGHT, top) && !boxHit(y, y + HEIGHT, top + Number(F1E5)) };
  }
  function description(code, axis, lo, hi, check, info) {
    var what = { y: 'y', x: 'x (after the drop)', z: 'z (after the drop)' }[axis];
    return 'Minecart track by 07km, with a built-in test' + (info && info.boat ? ' (boat cart' + (info.how === 'loader' ? ', loading run' : '') + ')' : '') + '. Paste with commands on; ' +
      'results in chat after ~' + Math.floor((check + 14) / 20) + 's. Target ' + what + ': ' + rangeText(lo, hi) +
      '. Button retests. Layout: ' + code + '. Java 26.2';
  }
  // The whole file: uncompressed NBT bytes, plus what the test should report when the start
  // rail is where it was built (the run, the drop for x / z, and the verdict).
  function file(code, startRail, facing, axis, lo, hi, uid, nowMs, opt) {
    var start = E.parse(code).start;
    var origin = start === 'S' ? startRail : [startRail[0], startRail[1] + 1, startRail[2]];
    var r = E.run(code, origin, facing, false, 20000, opt);
    if (!r.ok) throw new Error('the cart does not park on this track');
    // a loading run's cart starts its track only once the glass is broken, and falls a few blocks first
    var tt = build(code, startRail, facing, axis, lo, hi, uid, r.ticks + (E.startHow(opt) === 'loader' ? LOAD_WAIT + 40 : 0), opt);
    var enc = LW.encode(tt.blocks, 'Cart track test ' + code, '07km', description(code, axis, lo, hi, tt.info.check, tt.info), nowMs, tt.tes);
    var y = axis === 'y' ? r.y : E.dropY(code, origin, facing, r, opt);
    return { bytes: enc.bytes, offset: enc.offset, size: enc.size, info: tt.info, startRail: tt.startRail,
             end: [r.x, y, r.z], expect: verdict(tt.info, r.x, y, r.z) };
  }
  return { build: build, verdict: verdict, file: file, plain: plain, description: description, SUMMON_T: SUMMON_T };
}
