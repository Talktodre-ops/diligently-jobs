import sys, json
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
f = TTFont(sys.argv[1])
gs = f.getGlyphSet(); cmap = f.getBestCmap()
upm = f['head'].unitsPerEm; os2 = f['OS/2']
out = {"upm": upm, "xHeight": getattr(os2,'sxHeight',None), "capHeight": getattr(os2,'sCapHeight',None), "asc": f['hhea'].ascent, "desc": f['hhea'].descent, "glyphs": {}}
for ch in "diligently.":
    g = cmap[ord(ch)]
    p = SVGPathPen(gs); gs[g].draw(p)
    b = BoundsPen(gs); gs[g].draw(b)
    out["glyphs"][ch] = {"name": g, "adv": gs[g].width, "bounds": b.bounds, "d": p.getCommands()}
# kerning via GPOS pair adjustments (format 1 and 2), best effort
kern = {}
if 'GPOS' in f:
    from fontTools.ttLib.tables import otTables
    gpos = f['GPOS'].table
    names = {ch: cmap[ord(ch)] for ch in "diligently."}
    rev = {v:k for k,v in names.items()}
    for li in gpos.LookupList.Lookup:
        for st in li.SubTable:
            if li.LookupType == 9: st = st.ExtSubTable
            if getattr(st,'LookupType',li.LookupType) != 2 and li.LookupType not in (2,9): continue
            if not hasattr(st,'Format'): continue
            cov = st.Coverage.glyphs
            if st.Format == 1:
                for i,g1 in enumerate(cov):
                    if g1 not in rev: continue
                    for pvr in st.PairSet[i].PairValueRecord:
                        if pvr.SecondGlyph in rev and pvr.Value1 and getattr(pvr.Value1,'XAdvance',0):
                            kern.setdefault(rev[g1]+rev[pvr.SecondGlyph], pvr.Value1.XAdvance)
            elif st.Format == 2:
                cd1 = st.ClassDef1.classDefs; cd2 = st.ClassDef2.classDefs
                for g1 in cov:
                    if g1 not in rev: continue
                    for g2 in rev:
                        c1 = cd1.get(g1,0); c2 = cd2.get(g2,0)
                        v = st.Class1Record[c1].Class2Record[c2].Value1
                        if v and getattr(v,'XAdvance',0):
                            kern.setdefault(rev[g1]+rev[g2], v.XAdvance)
out["kern"] = kern
json.dump(out, open(sys.argv[2],'w'))
print(upm, out["xHeight"], out["capHeight"], out["asc"], out["desc"])
for ch,g in out["glyphs"].items(): print(repr(ch), g["adv"], g["bounds"])
print("kern", kern)
