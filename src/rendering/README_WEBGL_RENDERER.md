# WebGL 전용 합성 렌더러 1차 구조

이 폴더는 기존 브라우저 캡처형 렌더를 대체하기 위한 WebGL 기반 합성 렌더러 골격이다.

핵심 방향:
- 편집 UI는 React/DOM 유지
- 렌더는 ProjectState JSON만 보고 돌아감
- 영상/텍스트/shape/data8/data9 템플릿을 하나의 GPU 합성 파이프라인으로 그림
- 최종 프레임은 FFmpeg로 H.264 mp4 인코딩

현재 포함된 것:
- ProjectState / TimelineLayer 타입
- keyframe 보간 유틸
- data8/data9 템플릿을 캔버스로 rasterize 하는 1차 drawer
- WebGL2 textured quad compositor

현재 미포함:
- editor와 compositor 자동 동기화
- 실제 export job 연결
- 일반 Lottie 전체 해석기
- GPU 텍스트 atlas/MSDF

즉, 이 코드는 '전용 합성 렌더러 방향'으로 넘어가기 위한 1차 코드 베이스다.
