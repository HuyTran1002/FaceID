$baseUrl = "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/"
$files = @(
    "tiny_face_detector_model-weights_manifest.json",
    "tiny_face_detector_model-shard1",
    "face_landmark_68_model-weights_manifest.json",
    "face_landmark_68_model-shard1",
    "face_recognition_model-weights_manifest.json",
    "face_recognition_model-shard1",
    "face_expression_model-weights_manifest.json",
    "face_expression_model-shard1"
)

foreach ($file in $files) {
    $url = $baseUrl + $file
    $output = "models/" + $file
    Write-Host "Downloading $file..."
    Invoke-WebRequest -Uri $url -OutFile $output
}
