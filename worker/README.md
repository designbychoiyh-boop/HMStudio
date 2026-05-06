# AE 2025 Render Worker

이 폴더는 사내용 After Effects 2025 렌더 워커 연결용 예시입니다.

## 기본 폴더
- Desktop\VibeEdit_AE_Render_Server\assets
- Desktop\VibeEdit_AE_Render_Server\templates
- Desktop\VibeEdit_AE_Render_Server\jobs
- Desktop\VibeEdit_AE_Render_Server\renders
- Desktop\VibeEdit_AE_Render_Server\previews
- Desktop\VibeEdit_AE_Render_Server\logs
- Desktop\VibeEdit_AE_Render_Server\temp

## 웹 앱 동작
1. 영상 업로드 -> assets 저장
2. AEP 템플릿 업로드 -> templates 저장
3. Render 클릭 -> jobs 폴더에 jobId.json 생성
4. AE 워커가 jobId.json을 읽어서 AEP 렌더 수행
5. 완료 시 renders\jobId.mp4 저장
6. 웹 앱이 결과 파일을 감지하고 다운로드 버튼 노출

## 현재 샘플 템플릿
- mainCompName: TopTitle_F_04_AGL & NAVIADs
- editable fields:
  - Sub_텍스트
  - Main_텍스트 상
  - Main_텍스트 하
- font 변경: 가능
- color 변경: 가능

## 워커 구현 포인트
- 작업 JSON의 templateInstances[*].templatePath 로 AEP 로드
- templateInstances[*].mainCompName 로 메인 컴프 탐색
- fields 값을 해당 텍스트 레이어에 반영
- x/y/scale/rotation/opacity 값을 템플릿 인스턴스 transform 으로 반영
- composition.width/height/fps 를 최종 렌더 세팅에 반영
