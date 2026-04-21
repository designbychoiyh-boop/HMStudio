import re

path = r"c:\Users\user\Desktop\동영상편집프로그램\vibeedit_webgl_render_stage_v43_recreated\src\App.tsx"

with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Define the modal code to remove
modal_code_pattern = r'\s+\{/\* ── RENDER SETTINGS POPUP ── \*/\}\s+\{showRenderSettings && \([\s\S]+?\)\}'

# Remove all occurrences of the modal
cleaned_content = re.sub(modal_code_pattern, '', content)

# Now find the last occurrence of '    </div>\n  );\n}' in the VibeEdit component
# The VibeEdit component starts with 'export default function VibeEdit'
# We want to insert it before the very last </div> of the return.

# Instead of complex regex, let's just find the very end of the file and insert it there, 
# then fix the closing tags.
# Actually, the last 3 lines are:
#     </div>
#   );
#}

insertion_point = cleaned_content.rfind('    </div>\n  );\n}')

if insertion_point != -1:
    modal_to_insert = """
      {/* ── RENDER SETTINGS POPUP ── */}
      {showRenderSettings && (
        <div style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000 }}>
          <div style={{ width: 500, background: "#18181b", borderRadius: 12, border: `1px solid ${BORDER}`, overflow: "hidden", boxShadow: "0 20px 50px rgba(0,0,0,0.5)" }}>
            <div style={{ padding: "16px 20px", background: "#09090b", borderBottom: `1px solid ${BORDER}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: ACCENT2 }}>렌더 설정 (Stitch MCP)</span>
              <button onClick={() => setShowRenderSettings(false)} style={{ background: "transparent", border: "none", color: "#71717a", fontSize: 20, cursor: "pointer" }}>×</button>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 12 }}>아래의 MCP 서버 설정을 적용하여 렌더링을 시작합니다. 저장 위치 및 API 키를 확인해 주세요.</div>
              <textarea 
                value={JSON.stringify(mcpConfig, null, 2)} 
                onChange={e => { try { setMcpConfig(JSON.parse(e.target.value)); } catch {} }}
                style={{ width: "100%", height: 180, background: "#09090b", border: `1px solid ${BORDER}`, borderRadius: 8, color: "#22c55e", fontFamily: "monospace", fontSize: 11, padding: 12, outline: "none", resize: "none" }}
              />
              <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
                <button onClick={() => setShowRenderSettings(false)} style={{ flex: 1, padding: "10px", background: "#27272a", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, cursor: "pointer" }}>취소</button>
                <button onClick={startActualRender} style={{ flex: 2, padding: "10px", background: ACCENT2, color: "#000", border: "none", borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>렌더링 시작</button>
              </div>
            </div>
          </div>
        </div>
      )}
"""
    final_content = cleaned_content[:insertion_point + 10] + modal_to_insert + cleaned_content[insertion_point + 10:]
    with open(path, 'w', encoding='utf-8') as f:
        f.write(final_content)
    print("Successfully cleaned and updated App.tsx")
else:
    print("Could not find insertion point")
