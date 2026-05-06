import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.resolve(__dirname, 'src/App.tsx');
let content = fs.readFileSync(filePath, 'utf8');

const insertionMarker = '    </div>\n  );\n}';
const lastIndex = content.lastIndexOf(insertionMarker);

if (lastIndex !== -1) {
    const modalToInsert = `
      {/* ── RENDER SETTINGS POPUP ── */}
      {showRenderSettings && (
        <div style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000 }}>
          <div style={{ width: 500, background: "#18181b", borderRadius: 12, border: \`1px solid \${BORDER}\`, overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.5)" }}>
            <div style={{ padding: "16px 20px", background: "#09090b", borderBottom: \`1px solid \${BORDER}\`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: ACCENT2 }}>렌더 설정 (Stitch MCP)</span>
              <button onClick={() => setShowRenderSettings(false)} style={{ background: "transparent", border: "none", color: "#71717a", fontSize: 20, cursor: "pointer" }}>×</button>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 12 }}>아래의 MCP 서버 설정을 적용하여 렌더링을 시작합니다. 저장 위치 및 API 키를 확인해 주세요.</div>
              <textarea 
                value={JSON.stringify(mcpConfig, null, 2)} 
                onChange={e => { try { setMcpConfig(JSON.parse(e.target.value)); } catch {} }}
                style={{ width: "100%", height: 180, background: "#09090b", border: \`1px solid \${BORDER}\`, borderRadius: 8, color: "#22c55e", fontFamily: "monospace", fontSize: 11, padding: 12, outline: "none", resize: "none" }}
              />
              <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
                <button onClick={() => setShowRenderSettings(false)} style={{ flex: 1, padding: "10px", background: "#27272a", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, cursor: "pointer" }}>취소</button>
                <button onClick={startActualRender} style={{ flex: 2, padding: "10px", background: ACCENT2, color: "#000", border: "none", borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>렌더링 시작</button>
              </div>
            </div>
          </div>
        </div>
      )}
`;
    const result = content.slice(0, lastIndex + 10) + modalToInsert + content.slice(lastIndex + 10);
    fs.writeFileSync(filePath, result);
    console.log('Successfully updated App.tsx');
} else {
    console.log('Marker not found');
}
